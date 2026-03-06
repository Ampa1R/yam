import { and, db, eq, schema } from "@yam/db/pg";
import { chatMembersCache, publishToUsers, queues, rateLimit } from "@yam/db/redis";
import { scyllaQueries } from "@yam/db/scylla";
import type { Attachment, ServerEvent } from "@yam/shared";
import { Limits } from "@yam/shared";
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

export const messagesRoutes = new Elysia({ prefix: "/chats/:chatId/messages" })
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
				.where(
					and(eq(schema.chatMembers.chatId, params.chatId), eq(schema.chatMembers.userId, userId)),
				)
				.limit(1);

			if (!membership) {
				set.status = 403;
				return { error: "Not a member of this chat" };
			}

			const limit = Math.min(Number(query.limit) || Limits.DEFAULT_PAGE_SIZE, Limits.MAX_PAGE_SIZE);
			const messages = await scyllaQueries.getMessages(
				params.chatId,
				limit,
				query.cursor || undefined,
			);

			const nextCursor = messages.length === limit ? messages[messages.length - 1]?.id : null;

			return { messages, nextCursor };
		},
		{
			requireAuth: true,
			params: t.Object({ chatId: t.String() }),
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

			const memberIds = await getChatMemberIds(params.chatId);
			if (!memberIds.includes(userId)) {
				set.status = 403;
				return { error: "Not a member of this chat" };
			}

			const [chat] = await db
				.select({ type: schema.chats.type })
				.from(schema.chats)
				.where(eq(schema.chats.id, params.chatId))
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
				duration: null,
				waveform: null,
			}));

			const message = await scyllaQueries.insertMessage({
				chatId: params.chatId,
				senderId: userId,
				type: body.type,
				content: body.content,
				replyTo: body.replyTo,
				attachments,
			});

			const newMsgEvent: ServerEvent = { event: "message:new", data: message };
			const otherMembers = memberIds.filter((id) => id !== userId);
			await publishToUsers(otherMembers, newMsgEvent);

			const preview = (body.content || "").slice(0, Limits.INBOX_PREVIEW_LENGTH);
			await queues.inboxFanout.add({
				chatId: params.chatId,
				senderId: userId,
				messageType: body.type,
				messagePreview: preview,
				memberIds,
			});

			return { message };
		},
		{
			requireAuth: true,
			params: t.Object({ chatId: t.String() }),
			body: t.Object({
				type: t.Number(),
				content: t.String({ maxLength: Limits.MAX_MESSAGE_LENGTH }),
				replyTo: t.Optional(t.String()),
				attachments: t.Optional(
					t.Array(
						t.Object({
							type: t.Number(),
							url: t.String(),
							filename: t.Optional(t.String()),
							size: t.Number(),
							mimeType: t.String(),
						}),
					),
				),
			}),
		},
	);
