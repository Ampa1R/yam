import { db, eq, schema } from "@yam/db/pg";
import type { StreamJob } from "@yam/db/redis";
import { unread } from "@yam/db/redis";
import { scyllaQueries } from "@yam/db/scylla";

interface InboxFanoutPayload {
	chatId: string;
	senderId: string;
	messageType: number;
	messagePreview: string;
	memberIds: string[];
}

export async function processInboxFanout(job: StreamJob<InboxFanoutPayload>): Promise<void> {
	const { chatId, senderId, messageType, messagePreview, memberIds } = job.data;

	const [chat] = await db.select().from(schema.chats).where(eq(schema.chats.id, chatId)).limit(1);

	if (!chat) return;

	const now = new Date().toISOString();

	for (const memberId of memberIds) {
		const isSender = memberId === senderId;

		let chatName = chat.name;
		let otherUserId: string | null = null;

		if (chat.type === 0) {
			otherUserId = memberIds.find((id) => id !== memberId) ?? null;
			if (otherUserId) {
				const [otherUser] = await db
					.select({ displayName: schema.users.displayName })
					.from(schema.users)
					.where(eq(schema.users.id, otherUserId))
					.limit(1);
				chatName = otherUser?.displayName ?? "Unknown";
			}
		}

		await scyllaQueries.upsertInboxEntry(
			memberId,
			{
				chatId,
				chatType: chat.type,
				chatName,
				chatAvatar: chat.avatarUrl,
				otherUserId,
				lastMsgSender: senderId,
				lastMsgType: messageType,
				lastMsgPreview: messagePreview,
				lastActivity: now,
			},
			!isSender,
		);

		if (!isSender) {
			await unread.increment(memberId, chatId);
		}
	}
}
