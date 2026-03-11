import { createHash } from "node:crypto";
import { and, db, eq, inArray, schema, sql } from "@yam/db/pg";
import { chatMembersCache, directChatLookup, presence, publishToUsers, unread } from "@yam/db/redis";
import { scyllaQueries } from "@yam/db/scylla";
import { ChatRole, ChatType, type ChatType as ChatTypeT, type InboxItem, Limits } from "@yam/shared";
import { Elysia, t } from "elysia";
import { authMiddleware } from "../../lib/auth-middleware";

function directPairKey(userA: string, userB: string): string {
	return [userA, userB].sort().join(":");
}

function deterministicDirectChatId(userA: string, userB: string): string {
	const hex = createHash("md5").update(`direct:${directPairKey(userA, userB)}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function findExistingDirectChatId(userA: string, userB: string): Promise<string | null> {
	const rows = await db.execute<{ id: string }>(sql`
		SELECT c.id
		FROM chats c
		INNER JOIN chat_members cm ON cm.chat_id = c.id
		WHERE c.type = ${ChatType.DIRECT}
			AND cm.user_id::text IN (${userA}, ${userB})
		GROUP BY c.id
		HAVING COUNT(DISTINCT cm.user_id) = 2
		LIMIT 1
	`);
	return rows[0]?.id ?? null;
}

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

			const chatIds = inbox.map((i) => i.chatId);
			const redisUnreadMap = chatIds.length > 0
				? await unread.getMultiple(userId, chatIds)
				: new Map<string, number>();
			for (const item of inbox) {
				item.unreadCount = redisUnreadMap.get(item.chatId) ?? 0;
			}

			const otherUserIds = inbox
				.filter((i) => i.chatType === ChatType.DIRECT && i.otherUserId)
				.map((i) => i.otherUserId!);
			const presenceMap = otherUserIds.length > 0
				? await presence.getMultiplePresence(otherUserIds)
				: new Map();

			const presenceResult: Record<string, { isOnline: boolean; lastSeen: string | null }> = {};
			for (const [uid, p] of presenceMap) {
				presenceResult[uid] = { isOnline: p.online, lastSeen: p.lastSeen };
			}

			return { chats: inbox, presence: presenceResult };
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

			if (type !== ChatType.DIRECT && type !== ChatType.GROUP) {
				set.status = 400;
				return { error: "Invalid chat type" };
			}

			if (type === ChatType.DIRECT) {
				if (memberIds.length !== 1) {
					set.status = 400;
					return { error: "Direct chat requires exactly one other member" };
				}

				const otherId = memberIds[0]!;
				if (otherId === userId) {
					set.status = 400;
					return { error: "Cannot create direct chat with yourself" };
				}

				const [otherUser] = await db
					.select({ id: schema.users.id, displayName: schema.users.displayName })
					.from(schema.users)
					.where(eq(schema.users.id, otherId))
					.limit(1);
				if (!otherUser) {
					set.status = 404;
					return { error: "Target user not found" };
				}

				const cachedChatId = await directChatLookup.get(userId, otherId);
				const existingDirectId = cachedChatId ?? (await findExistingDirectChatId(userId, otherId));
				if (existingDirectId) {
					const [chat] = await db
						.select()
						.from(schema.chats)
						.where(eq(schema.chats.id, existingDirectId))
						.limit(1);
					if (chat) {
						await directChatLookup.set(userId, otherId, chat.id);
						return { chat, created: false };
					}
				}

				const directChatId = deterministicDirectChatId(userId, otherId);
				const [insertedChat] = await db
					.insert(schema.chats)
					.values({
						id: directChatId,
						type: ChatType.DIRECT,
						createdBy: userId,
						memberCount: 2,
					})
					.onConflictDoNothing({ target: [schema.chats.id] })
					.returning();

				const chat = insertedChat
					? insertedChat
					: (
							await db
								.select()
								.from(schema.chats)
								.where(eq(schema.chats.id, directChatId))
								.limit(1)
						)[0];

				if (!chat) {
					set.status = 500;
					return { error: "Failed to create chat" };
				}

				await db.insert(schema.chatMembers).values([
					{ chatId: chat.id, userId, role: ChatRole.OWNER },
					{ chatId: chat.id, userId: otherId, role: ChatRole.MEMBER },
				]).onConflictDoNothing({ target: [schema.chatMembers.chatId, schema.chatMembers.userId] });

				await directChatLookup.set(userId, otherId, chat.id);
				await chatMembersCache.set(chat.id, [userId, otherId]);

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

			const existingUsers = await db
				.select({ id: schema.users.id })
				.from(schema.users)
				.where(inArray(schema.users.id, allMembers));
			if (existingUsers.length !== allMembers.length) {
				set.status = 400;
				return { error: "One or more members do not exist" };
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

			const otherMemberIds = allMembers.filter((id) => id !== userId);
			if (otherMemberIds.length > 0) {
				const { randomUUID } = await import("node:crypto");
				await publishToUsers(otherMemberIds, {
					event: "chat:updated",
					data: {
						chatId: chat.id,
						lastMessage: null,
						unreadCount: 0,
					},
					eventId: randomUUID(),
				});
			}

			return { chat, created: true };
		},
		{
			requireAuth: true,
			body: t.Object({
				type: t.Number({ minimum: ChatType.DIRECT, maximum: ChatType.GROUP }),
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

			const memberUserIds = members.map((m) => m.userId);
			const memberPresence = await presence.getMultiplePresence(memberUserIds);

			return {
				chat,
				members: members.map((m) => {
					const p = memberPresence.get(m.userId);
					return {
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
						isOnline: p?.online ?? false,
					};
				}),
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
	)
	.patch(
		"/:id/membership",
		async ({ params, body, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			if (body.isPinned === undefined && body.isMuted === undefined) {
				set.status = 400;
				return { error: "At least one field is required: isPinned or isMuted" };
			}

			const updates: { isPinned?: boolean; isMuted?: boolean } = {};
			if (body.isPinned !== undefined) updates.isPinned = body.isPinned;
			if (body.isMuted !== undefined) updates.isMuted = body.isMuted;

			const updated = await db
				.update(schema.chatMembers)
				.set(updates)
				.where(and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)))
				.returning({
					chatId: schema.chatMembers.chatId,
					userId: schema.chatMembers.userId,
					isPinned: schema.chatMembers.isPinned,
					isMuted: schema.chatMembers.isMuted,
				});
			if (updated.length === 0) {
				set.status = 404;
				return { error: "Membership not found" };
			}

			return { membership: updated[0] };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
			body: t.Object({
				isPinned: t.Optional(t.Boolean()),
				isMuted: t.Optional(t.Boolean()),
			}),
		},
	)
	.patch(
		"/:id/pin",
		async ({ params, body, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const updated = await db
				.update(schema.chatMembers)
				.set({ isPinned: body.isPinned })
				.where(
					and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)),
				)
				.returning({ chatId: schema.chatMembers.chatId });

			if (updated.length === 0) {
				set.status = 404;
				return { error: "Chat not found" };
			}

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

			const updated = await db
				.update(schema.chatMembers)
				.set({ isMuted: body.isMuted })
				.where(
					and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)),
				)
				.returning({ chatId: schema.chatMembers.chatId });

			if (updated.length === 0) {
				set.status = 404;
				return { error: "Chat not found" };
			}

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
			body: t.Object({ isMuted: t.Boolean() }),
		},
	)
	.delete(
		"/:id",
		async ({ params, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const [chat] = await db
				.select({ type: schema.chats.type })
				.from(schema.chats)
				.where(eq(schema.chats.id, params.id))
				.limit(1);
			if (!chat || chat.type !== ChatType.DIRECT) {
				set.status = 400;
				return { error: "Only direct chats can be deleted. Use leave for groups." };
			}

			const [membership] = await db
				.select()
				.from(schema.chatMembers)
				.where(and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)))
				.limit(1);
			if (!membership) {
				set.status = 404;
				return { error: "Not a member of this chat" };
			}

			await scyllaQueries.deleteInboxEntry(userId, params.id);
			await unread.reset(userId, params.id);

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
		},
	)
	.delete(
		"/:id/leave",
		async ({ params, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const [chat] = await db
				.select({ type: schema.chats.type })
				.from(schema.chats)
				.where(eq(schema.chats.id, params.id))
				.limit(1);
			if (!chat || chat.type !== ChatType.GROUP) {
				set.status = 400;
				return { error: "Leave operation is available only for group chats" };
			}

			const [myMembership] = await db
				.select({ role: schema.chatMembers.role })
				.from(schema.chatMembers)
				.where(
					and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)),
				)
				.limit(1);
			if (!myMembership) {
				set.status = 404;
				return { error: "You are not a member of this chat" };
			}
			if (myMembership.role === ChatRole.OWNER) {
				set.status = 400;
				return { error: "Owner cannot leave the group. Transfer ownership first." };
			}

			let leftRows: { userId: string }[] = [];
			await db.transaction(async (tx) => {
				leftRows = await tx
					.delete(schema.chatMembers)
					.where(
						and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)),
					)
					.returning({ userId: schema.chatMembers.userId });

				if (leftRows.length > 0) {
					await tx
						.update(schema.chats)
						.set({ memberCount: sql`${schema.chats.memberCount} - 1`, updatedAt: new Date() })
						.where(eq(schema.chats.id, params.id));
				}
			});

			if (leftRows.length === 0) {
				set.status = 404;
				return { error: "You are not a member of this chat" };
			}

			await chatMembersCache.invalidate(params.id);
			await scyllaQueries.deleteInboxEntry(userId, params.id);
			await unread.reset(userId, params.id);

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
		},
	);
