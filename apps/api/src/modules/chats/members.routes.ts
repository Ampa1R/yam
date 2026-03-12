import { and, db, eq, schema, sql } from "@yam/db/pg";
import { chatMembersCache, publishToUsers, unread } from "@yam/db/redis";
import { scyllaQueries } from "@yam/db/scylla";
import { ChatRole, ChatType, type ChatType as ChatTypeT, Limits } from "@yam/shared";
import { Elysia, t } from "elysia";
import { authMiddleware } from "../../lib/auth-middleware";

export const membersRoutes = new Elysia()
	.use(authMiddleware)
	.post(
		"/:id/members",
		async ({ params, body, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const [membership] = await db
				.select()
				.from(schema.chatMembers)
				.where(and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)))
				.limit(1);

			if (!membership || membership.role < ChatRole.ADMIN) {
				set.status = 403;
				return { error: "Only admins can add members" };
			}

			const [chat] = await db
				.select()
				.from(schema.chats)
				.where(eq(schema.chats.id, params.id))
				.limit(1);

			if (!chat || chat.type !== ChatType.GROUP) {
				set.status = 400;
				return { error: "Members can be managed only in group chats" };
			}

			if (chat.memberCount >= Limits.MAX_GROUP_SIZE) {
				set.status = 400;
				return { error: `Group is at maximum capacity (${Limits.MAX_GROUP_SIZE})` };
			}

			const [targetUser] = await db
				.select({ id: schema.users.id })
				.from(schema.users)
				.where(eq(schema.users.id, body.userId))
				.limit(1);
			if (!targetUser) {
				set.status = 404;
				return { error: "User not found" };
			}

			const [existingMember] = await db
				.select({ userId: schema.chatMembers.userId })
				.from(schema.chatMembers)
				.where(
					and(
						eq(schema.chatMembers.chatId, params.id),
						eq(schema.chatMembers.userId, body.userId),
					),
				)
				.limit(1);
			if (existingMember) {
				return { success: true, alreadyMember: true };
			}

			await db.transaction(async (tx) => {
				await tx
					.insert(schema.chatMembers)
					.values({ chatId: params.id, userId: body.userId });
				await tx
					.update(schema.chats)
					.set({ memberCount: sql`${schema.chats.memberCount} + 1`, updatedAt: new Date() })
					.where(eq(schema.chats.id, params.id));
			});

			await chatMembersCache.invalidate(params.id);

			await scyllaQueries.upsertInboxEntry(body.userId, {
				chatId: params.id,
				chatType: chat.type as ChatTypeT,
				chatName: chat.name,
				chatAvatar: chat.avatarUrl,
				otherUserId: null,
				lastMsgSender: null,
				lastMsgType: null,
				lastMsgPreview: null,
				lastActivity: new Date().toISOString(),
			});

			const { randomUUID } = await import("node:crypto");
			await publishToUsers([body.userId], {
				event: "chat:updated",
				data: {
					chatId: params.id,
					lastMessage: null,
					unreadCount: 0,
				},
				eventId: randomUUID(),
			});

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
			body: t.Object({ userId: t.String() }),
		},
	)
	.delete(
		"/:id/members/:memberId",
		async ({ params, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const [membership] = await db
				.select()
				.from(schema.chatMembers)
				.where(and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)))
				.limit(1);

			if (!membership || (membership.role < ChatRole.ADMIN && userId !== params.memberId)) {
				set.status = 403;
				return { error: "Not authorized to remove this member" };
			}

			const [chat] = await db
				.select({ type: schema.chats.type })
				.from(schema.chats)
				.where(eq(schema.chats.id, params.id))
				.limit(1);
			if (!chat || chat.type !== ChatType.GROUP) {
				set.status = 400;
				return { error: "Members can be managed only in group chats" };
			}

			const [targetMembership] = await db
				.select({ role: schema.chatMembers.role, userId: schema.chatMembers.userId })
				.from(schema.chatMembers)
				.where(
					and(
						eq(schema.chatMembers.chatId, params.id),
						eq(schema.chatMembers.userId, params.memberId),
					),
				)
				.limit(1);
			if (!targetMembership) {
				set.status = 404;
				return { error: "Member not found in this chat" };
			}
			if (targetMembership.role === ChatRole.OWNER) {
				set.status = 400;
				return { error: "Owner cannot be removed. Transfer ownership first." };
			}

			let removedMembers: { userId: string }[] = [];
			await db.transaction(async (tx) => {
				removedMembers = await tx
					.delete(schema.chatMembers)
					.where(
						and(
							eq(schema.chatMembers.chatId, params.id),
							eq(schema.chatMembers.userId, params.memberId),
						),
					)
					.returning({ userId: schema.chatMembers.userId });

				if (removedMembers.length > 0) {
					await tx
						.update(schema.chats)
						.set({ memberCount: sql`${schema.chats.memberCount} - 1`, updatedAt: new Date() })
						.where(eq(schema.chats.id, params.id));
				}
			});

			if (removedMembers.length === 0) {
				set.status = 404;
				return { error: "Member not found in this chat" };
			}

			await chatMembersCache.invalidate(params.id);
			await scyllaQueries.deleteInboxEntry(params.memberId, params.id);
			await unread.reset(params.memberId, params.id);

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String(), memberId: t.String() }),
		},
	)
	.patch(
		"/:id/members/:memberId/role",
		async ({ params, body, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const [myMembership] = await db
				.select()
				.from(schema.chatMembers)
				.where(and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)))
				.limit(1);

			if (!myMembership || myMembership.role < ChatRole.OWNER) {
				set.status = 403;
				return { error: "Only the owner can change member roles" };
			}

			const [chat] = await db
				.select({ type: schema.chats.type })
				.from(schema.chats)
				.where(eq(schema.chats.id, params.id))
				.limit(1);
			if (!chat || chat.type !== ChatType.GROUP) {
				set.status = 400;
				return { error: "Roles can be changed only in group chats" };
			}

			if (body.role !== ChatRole.MEMBER && body.role !== ChatRole.ADMIN) {
				set.status = 400;
				return { error: "Invalid role value" };
			}

			if (body.role >= ChatRole.OWNER) {
				set.status = 400;
				return { error: "Cannot assign owner role directly — use transfer endpoint" };
			}

			const [targetMembership] = await db
				.select()
				.from(schema.chatMembers)
				.where(
					and(
						eq(schema.chatMembers.chatId, params.id),
						eq(schema.chatMembers.userId, params.memberId),
					),
				)
				.limit(1);

			if (!targetMembership) {
				set.status = 404;
				return { error: "Member not found in this chat" };
			}

			await db
				.update(schema.chatMembers)
				.set({ role: body.role })
				.where(
					and(
						eq(schema.chatMembers.chatId, params.id),
						eq(schema.chatMembers.userId, params.memberId),
					),
				);

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String(), memberId: t.String() }),
			body: t.Object({ role: t.Number({ minimum: ChatRole.MEMBER, maximum: ChatRole.ADMIN }) }),
		},
	)
	.post(
		"/:id/transfer",
		async ({ params, body, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const [myMembership] = await db
				.select()
				.from(schema.chatMembers)
				.where(and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)))
				.limit(1);

			if (!myMembership || myMembership.role < ChatRole.OWNER) {
				set.status = 403;
				return { error: "Only the owner can transfer ownership" };
			}

			const [chat] = await db
				.select({ type: schema.chats.type })
				.from(schema.chats)
				.where(eq(schema.chats.id, params.id))
				.limit(1);
			if (!chat || chat.type !== ChatType.GROUP) {
				set.status = 400;
				return { error: "Ownership transfer is available only for group chats" };
			}

			if (body.userId === userId) {
				set.status = 400;
				return { error: "Cannot transfer ownership to yourself" };
			}

			const [targetMembership] = await db
				.select()
				.from(schema.chatMembers)
				.where(
					and(
						eq(schema.chatMembers.chatId, params.id),
						eq(schema.chatMembers.userId, body.userId),
					),
				)
				.limit(1);

			if (!targetMembership) {
				set.status = 404;
				return { error: "Target user is not a member of this chat" };
			}

			await db.transaction(async (tx) => {
				await tx
					.update(schema.chatMembers)
					.set({ role: ChatRole.OWNER })
					.where(
						and(
							eq(schema.chatMembers.chatId, params.id),
							eq(schema.chatMembers.userId, body.userId),
						),
					);
				await tx
					.update(schema.chatMembers)
					.set({ role: ChatRole.ADMIN })
					.where(
						and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)),
					);
			});

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
			body: t.Object({ userId: t.String() }),
		},
	);
