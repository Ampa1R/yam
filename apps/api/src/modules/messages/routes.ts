import { randomUUID } from "node:crypto";
import { and, db, eq, schema } from "@yam/db/pg";
import { chatMembersCache, publishToUsers, queues, rateLimit } from "@yam/db/redis";
import { scyllaQueries } from "@yam/db/scylla";
import type { Attachment, ServerEvent } from "@yam/shared";
import { AttachmentType, Limits, MessageType } from "@yam/shared";
import { Elysia, t } from "elysia";
import { authMiddleware } from "../../lib/auth-middleware";

async function getChatMemberIds(chatId: string): Promise<string[]> {
	const cached = await chatMembersCache.get(chatId);
	if (cached) return cached;

	const members = await db
		.select({ userId: schema.chatMembers.userId })
		.from(schema.chatMembers)
		.where(eq(schema.chatMembers.chatId, chatId));

	const ids = members.map((m) => m.userId);
	await chatMembersCache.set(chatId, ids);
	return ids;
}

export const messagesRoutes = new Elysia({ prefix: "/chats/:id/messages" })
	.use(authMiddleware)
	.get(
		"/",
		async ({ params, query, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const [membership] = await db
				.select()
				.from(schema.chatMembers)
				.where(and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)))
				.limit(1);

			if (!membership) {
				set.status = 403;
				return { error: "Not a member of this chat" };
			}

			const limit = Math.min(Number(query.limit) || Limits.DEFAULT_PAGE_SIZE, Limits.MAX_PAGE_SIZE);
			const messages = await scyllaQueries.getMessages(params.id, limit, query.cursor || undefined);

			const nextCursor = messages.length === limit ? messages[messages.length - 1]?.id : null;

			return { messages, nextCursor };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
			query: t.Object({
				cursor: t.Optional(t.String()),
				limit: t.Optional(t.String()),
			}),
		},
	)
	.post(
		"/",
		async ({ params, body, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const allowed = await rateLimit.check(
				`${userId}:msg`,
				Limits.RATE_LIMIT_MESSAGES_PER_MIN,
				60,
			);
			if (!allowed) {
				set.status = 429;
				return { error: "Message rate limit exceeded" };
			}

			const memberIds = await getChatMemberIds(params.id);
			if (!memberIds.includes(userId)) {
				set.status = 403;
				return { error: "Not a member of this chat" };
			}

			const [chat] = await db
				.select({ type: schema.chats.type })
				.from(schema.chats)
				.where(eq(schema.chats.id, params.id))
				.limit(1);

			if (chat?.type === 0) {
				const otherId = memberIds.find((id) => id !== userId);
				if (otherId) {
					const [blocked] = await db
						.select()
						.from(schema.blockedUsers)
						.where(
							and(
								eq(schema.blockedUsers.userId, otherId),
								eq(schema.blockedUsers.blockedId, userId),
							),
						)
						.limit(1);
					if (blocked) {
						set.status = 403;
						return { error: "You cannot send messages to this user" };
					}
				}
			}

			const attachments: Attachment[] | undefined = body.attachments?.map((a) => ({
				type: a.type as Attachment["type"],
				url: a.url,
				filename: a.filename ?? null,
				size: a.size,
				mimeType: a.mimeType,
				width: null,
				height: null,
				duration: a.duration ?? null,
				waveform: a.waveform ?? null,
			}));

			const message = await scyllaQueries.insertMessage({
				chatId: params.id,
				senderId: userId,
				type: body.type,
				content: body.content,
				replyTo: body.replyTo,
				attachments,
			});

			const newMsgEvent: ServerEvent = {
				event: "message:new",
				data: message,
				eventId: randomUUID(),
			};
			const otherMembers = memberIds.filter((id) => id !== userId);
			await publishToUsers(otherMembers, newMsgEvent);

			let preview = (body.content || "").slice(0, Limits.INBOX_PREVIEW_LENGTH);
			if (!preview && body.type === MessageType.VOICE) preview = "🎤 Voice message";
			else if (!preview && attachments && attachments.length > 0) preview = "📎 Attachment";
			await queues.inboxFanout.add({
				chatId: params.id,
				senderId: userId,
				messageType: body.type,
				messagePreview: preview,
				createdAt: message.createdAt,
			});

			return { message };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
			body: t.Object({
				type: t.Number({ minimum: MessageType.TEXT, maximum: MessageType.VOICE }),
				content: t.String({ maxLength: Limits.MAX_MESSAGE_LENGTH }),
				replyTo: t.Optional(t.String()),
				attachments: t.Optional(
					t.Array(
						t.Object({
							type: t.Number({ minimum: AttachmentType.IMAGE, maximum: AttachmentType.VOICE }),
							url: t.String({ pattern: "^/api/files/" }),
							filename: t.Optional(t.String({ maxLength: 255 })),
							size: t.Number({ minimum: 0 }),
							mimeType: t.String({ maxLength: 100 }),
							duration: t.Optional(t.Number({ minimum: 0, maximum: 86400 })),
							waveform: t.Optional(t.Array(t.Number(), { maxItems: 100 })),
						}),
						{ maxItems: 10 },
					),
				),
			}),
		},
	);
