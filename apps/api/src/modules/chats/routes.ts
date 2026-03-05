import { and, db, eq, schema, sql } from "@yam/db/pg";
import { chatMembersCache, directChatLookup } from "@yam/db/redis";
import { scyllaQueries } from "@yam/db/scylla";
import { ChatRole, ChatType, type ChatType as ChatTypeT, type InboxItem, Limits } from "@yam/shared";
import { Elysia, t } from "elysia";
import { authMiddleware } from "../../lib/auth-middleware";

export const chatsRoutes = new Elysia({ prefix: "/chats" })
	.use(authMiddleware)
	.get(
		"/",
		async ({ userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const inbox = await scyllaQueries.getInbox(userId);
			return { chats: inbox };
		},
		{ requireAuth: true },
	)
	.post(
		"/",
		async ({ body, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const { type, memberIds, name } = body;

			if (type === ChatType.DIRECT) {
				if (memberIds.length !== 1) {
					set.status = 400;
					return { error: "Direct chat requires exactly one other member" };
				}

				const otherId = memberIds[0]!;
				const existing = await directChatLookup.get(userId, otherId);
				if (existing) {
					const [chat] = await db
						.select()
						.from(schema.chats)
						.where(eq(schema.chats.id, existing))
						.limit(1);
					if (chat) {
						return { chat, created: false };
					}
				}

				const [chat] = await db
					.insert(schema.chats)
					.values({
						type: ChatType.DIRECT,
						createdBy: userId,
						memberCount: 2,
					})
					.returning();

				if (!chat) {
					set.status = 500;
					return { error: "Failed to create chat" };
				}

				await db.insert(schema.chatMembers).values([
					{ chatId: chat.id, userId, role: ChatRole.OWNER },
					{ chatId: chat.id, userId: otherId, role: ChatRole.MEMBER },
				]);

				await directChatLookup.set(userId, otherId, chat.id);
				await chatMembersCache.set(chat.id, [userId, otherId]);

				const [otherUser] = await db
					.select({ displayName: schema.users.displayName })
					.from(schema.users)
					.where(eq(schema.users.id, otherId))
					.limit(1);
				const [me] = await db
					.select({ displayName: schema.users.displayName })
					.from(schema.users)
					.where(eq(schema.users.id, userId))
					.limit(1);

				const now = new Date().toISOString();
				const baseEntry: Omit<InboxItem, "unreadCount" | "isPinned" | "isMuted"> = {
					chatId: chat.id,
					chatType: ChatType.DIRECT,
					chatName: null,
					chatAvatar: null,
					otherUserId: otherId,
					lastMsgSender: null,
					lastMsgType: null,
					lastMsgPreview: null,
					lastActivity: now,
				};
				await scyllaQueries.upsertInboxEntry(userId, {
					...baseEntry,
					chatName: otherUser?.displayName ?? "User",
				});
				await scyllaQueries.upsertInboxEntry(otherId, {
					...baseEntry,
					otherUserId: userId,
					chatName: me?.displayName ?? "User",
				});

				return { chat, created: true };
			}

		if (!name) {
			set.status = 400;
			return { error: "Group chat requires a name" };
		}

		const allMembers = [...new Set([userId, ...memberIds])];

		if (allMembers.length < 2) {
			set.status = 400;
			return { error: "Group chat requires at least one other member" };
		}

		if (allMembers.length > Limits.MAX_GROUP_SIZE) {
				set.status = 400;
				return { error: `Group cannot exceed ${Limits.MAX_GROUP_SIZE} members` };
			}

			const [chat] = await db
				.insert(schema.chats)
				.values({
					type: ChatType.GROUP,
					name,
					createdBy: userId,
					memberCount: allMembers.length,
				})
				.returning();

			if (!chat) {
				set.status = 500;
				return { error: "Failed to create chat" };
			}

			const memberRows = allMembers.map((uid) => ({
				chatId: chat.id,
				userId: uid,
				role: uid === userId ? ChatRole.OWNER : ChatRole.MEMBER,
			}));

			await db.insert(schema.chatMembers).values(memberRows);
			await chatMembersCache.set(chat.id, allMembers);

			const now = new Date().toISOString();
			for (const memberId of allMembers) {
				await scyllaQueries.upsertInboxEntry(memberId, {
					chatId: chat.id,
					chatType: ChatType.GROUP,
					chatName: name,
					chatAvatar: null,
					otherUserId: null,
					lastMsgSender: null,
					lastMsgType: null,
					lastMsgPreview: null,
					lastActivity: now,
				});
			}

			return { chat, created: true };
		},
		{
			requireAuth: true,
			body: t.Object({
				type: t.Number(),
				memberIds: t.Array(t.String()),
				name: t.Optional(t.String({ maxLength: 200 })),
			}),
		},
	)
	.get(
		"/:id",
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

			if (!membership) {
				set.status = 403;
				return { error: "Not a member of this chat" };
			}

			const [chat] = await db
				.select()
				.from(schema.chats)
				.where(eq(schema.chats.id, params.id))
				.limit(1);

			if (!chat) {
				set.status = 404;
				return { error: "Chat not found" };
			}

			const members = await db
				.select({
					chatId: schema.chatMembers.chatId,
					userId: schema.chatMembers.userId,
					role: schema.chatMembers.role,
					isPinned: schema.chatMembers.isPinned,
					isMuted: schema.chatMembers.isMuted,
					joinedAt: schema.chatMembers.joinedAt,
					displayName: schema.users.displayName,
					username: schema.users.username,
					avatarUrl: schema.users.avatarUrl,
				})
				.from(schema.chatMembers)
				.innerJoin(schema.users, eq(schema.chatMembers.userId, schema.users.id))
				.where(eq(schema.chatMembers.chatId, params.id));

			return {
				chat,
				members: members.map((m) => ({
					userId: m.userId,
					role: m.role,
					isPinned: m.isPinned,
					isMuted: m.isMuted,
					joinedAt: m.joinedAt?.toISOString(),
					user: {
						id: m.userId,
						displayName: m.displayName,
						username: m.username,
						avatarUrl: m.avatarUrl,
					},
				})),
				myMembership: membership,
			};
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
		},
	)
	.patch(
		"/:id",
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
				return { error: "Only admins can update chat settings" };
			}

			const updates: Record<string, unknown> = { updatedAt: new Date() };
			if (body.name !== undefined) updates.name = body.name;
			if (body.description !== undefined) updates.description = body.description;
			if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl;

			const [chat] = await db
				.update(schema.chats)
				.set(updates)
				.where(eq(schema.chats.id, params.id))
				.returning();

			return { chat };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
			body: t.Object({
				name: t.Optional(t.String({ maxLength: 200 })),
				description: t.Optional(t.Nullable(t.String())),
				avatarUrl: t.Optional(t.Nullable(t.String())),
			}),
		},
	)
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

			if (!chat || chat.memberCount >= Limits.MAX_GROUP_SIZE) {
				set.status = 400;
				return { error: `Group is at maximum capacity (${Limits.MAX_GROUP_SIZE})` };
			}

			await db
				.insert(schema.chatMembers)
				.values({ chatId: params.id, userId: body.userId })
				.onConflictDoNothing({ target: [schema.chatMembers.chatId, schema.chatMembers.userId] });

			await db
				.update(schema.chats)
				.set({ memberCount: sql`${schema.chats.memberCount} + 1`, updatedAt: new Date() })
				.where(eq(schema.chats.id, params.id));

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

			await db
				.delete(schema.chatMembers)
				.where(
					and(
						eq(schema.chatMembers.chatId, params.id),
						eq(schema.chatMembers.userId, params.memberId),
					),
				);

			await db
				.update(schema.chats)
				.set({ memberCount: sql`${schema.chats.memberCount} - 1`, updatedAt: new Date() })
				.where(eq(schema.chats.id, params.id));

			await chatMembersCache.invalidate(params.id);

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String(), memberId: t.String() }),
		},
	)
	.patch(
		"/:id/pin",
		async ({ params, body, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			await db
				.update(schema.chatMembers)
				.set({ isPinned: body.isPinned })
				.where(
					and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)),
				);

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
			body: t.Object({ isPinned: t.Boolean() }),
		},
	)
	.patch(
		"/:id/mute",
		async ({ params, body, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			await db
				.update(schema.chatMembers)
				.set({ isMuted: body.isMuted })
				.where(
					and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)),
				);

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
			body: t.Object({ isMuted: t.Boolean() }),
		},
	)
	.delete(
		"/:id/leave",
		async ({ params, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			await db
				.delete(schema.chatMembers)
				.where(
					and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)),
				);

			await db
				.update(schema.chats)
				.set({ memberCount: sql`${schema.chats.memberCount} - 1`, updatedAt: new Date() })
				.where(eq(schema.chats.id, params.id));

			await chatMembersCache.invalidate(params.id);

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
		},
	);
