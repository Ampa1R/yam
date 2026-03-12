
import { presence, unread } from "@yam/db/redis";
import { scyllaQueries } from "@yam/db/scylla";
import { ChatType } from "@yam/shared";
import { Elysia } from "elysia";
import { authMiddleware } from "../../lib/auth-middleware";

export const inboxRoutes = new Elysia()
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
	);
