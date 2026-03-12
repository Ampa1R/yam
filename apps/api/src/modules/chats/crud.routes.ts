import { and, db, eq, inArray, schema, } from "@yam/db/pg";
import { chatMembersCache, directChatLookup, presence, publishToUsers, unread } from "@yam/db/redis";
import { scyllaQueries } from "@yam/db/scylla";
import { ChatRole, ChatType, type InboxItem, Limits } from "@yam/shared";
import { Elysia, t } from "elysia";
import { authMiddleware } from "../../lib/auth-middleware";
import { deterministicDirectChatId, findExistingDirectChatId } from "./utils";

interface RouteSet { status?: number | string };

async function createDirectChat(userId: string, otherId: string, set: RouteSet) {
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
		const [chat] = await db.select().from(schema.chats).where(eq(schema.chats.id, existingDirectId)).limit(1);
		if (chat) {
			await directChatLookup.set(userId, otherId, chat.id);
			return { chat, created: false };
		}
	}

	const directChatId = deterministicDirectChatId(userId, otherId);
	const [insertedChat] = await db
		.insert(schema.chats)
		.values({ id: directChatId, type: ChatType.DIRECT, createdBy: userId, memberCount: 2 })
		.onConflictDoNothing({ target: [schema.chats.id] })
		.returning();

	const chat = insertedChat ?? (await db.select().from(schema.chats).where(eq(schema.chats.id, directChatId)).limit(1))[0];
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
	await scyllaQueries.upsertInboxEntry(userId, { ...baseEntry, chatName: otherUser?.displayName ?? "User" });
	await scyllaQueries.upsertInboxEntry(otherId, { ...baseEntry, otherUserId: userId, chatName: me?.displayName ?? "User" });

	return { chat, created: true };
}

async function createGroupChat(userId: string, memberIds: string[], name: string, set: RouteSet) {
	const allMembers = [...new Set([userId, ...memberIds])];

	if (allMembers.length < 2) {
		set.status = 400;
		return { error: "Group chat requires at least one other member" };
	}
	if (allMembers.length > Limits.MAX_GROUP_SIZE) {
		set.status = 400;
		return { error: `Group cannot exceed ${Limits.MAX_GROUP_SIZE} members` };
	}

	const existingUsers = await db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.id, allMembers));
	if (existingUsers.length !== allMembers.length) {
		set.status = 400;
		return { error: "One or more members do not exist" };
	}

	const [chat] = await db
		.insert(schema.chats)
		.values({ type: ChatType.GROUP, name, createdBy: userId, memberCount: allMembers.length })
		.returning();
	if (!chat) {
		set.status = 500;
		return { error: "Failed to create chat" };
	}

	await db.insert(schema.chatMembers).values(
		allMembers.map((uid) => ({ chatId: chat.id, userId: uid, role: uid === userId ? ChatRole.OWNER : ChatRole.MEMBER })),
	);
	await chatMembersCache.set(chat.id, allMembers);

	const now = new Date().toISOString();
	for (const memberId of allMembers) {
		await scyllaQueries.upsertInboxEntry(memberId, {
			chatId: chat.id, chatType: ChatType.GROUP, chatName: name, chatAvatar: null,
			otherUserId: null, lastMsgSender: null, lastMsgType: null, lastMsgPreview: null, lastActivity: now,
		});
	}

	const otherMemberIds = allMembers.filter((id) => id !== userId);
	if (otherMemberIds.length > 0) {
		const { randomUUID } = await import("node:crypto");
		await publishToUsers(otherMemberIds, {
			event: "chat:updated",
			data: { chatId: chat.id, lastMessage: null, unreadCount: 0 },
			eventId: randomUUID(),
		});
	}

	return { chat, created: true };
}

export const crudRoutes = new Elysia()
	.use(authMiddleware)
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
				return createDirectChat(userId, memberIds[0]!, set);
			}

			if (type === ChatType.GROUP) {
				if (!name) {
					set.status = 400;
					return { error: "Group chat requires a name" };
				}
				return createGroupChat(userId, memberIds, name, set);
			}

			set.status = 400;
			return { error: "Invalid chat type" };
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
	);
