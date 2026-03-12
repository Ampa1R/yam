import { db, eq, inArray, schema } from "@yam/db/pg";
import type { StreamJob } from "@yam/db/redis";
import { unread } from "@yam/db/redis";
import { scyllaQueries } from "@yam/db/scylla";
import type { ChatType } from "@yam/shared";

interface InboxFanoutPayload {
	chatId: string;
	senderId: string;
	messageType: number;
	messagePreview: string;
	createdAt?: string;
}

export async function processInboxFanout(job: StreamJob<InboxFanoutPayload>): Promise<void> {
	const t0 = performance.now();
	const { chatId, senderId, messageType, messagePreview, createdAt } = job.data;

	const msgTime = createdAt ? new Date(createdAt) : new Date();
	const lag = Date.now() - msgTime.getTime();
	const lastActivity = msgTime.toISOString();

	const t1 = performance.now();
	const [chatResult, allMemberships] = await Promise.all([
		db.select().from(schema.chats).where(eq(schema.chats.id, chatId)).limit(1),
		db
			.select({ userId: schema.chatMembers.userId, lastReadAt: schema.chatMembers.lastReadAt })
			.from(schema.chatMembers)
			.where(eq(schema.chatMembers.chatId, chatId)),
	]);
	const t2 = performance.now();

	const chat = chatResult[0];
	if (!chat) return;

	const currentMemberIds = allMemberships.map((m) => m.userId);
	const nonSenderMembers = currentMemberIds.filter((id) => id !== senderId);

	let displayNameMap: Map<string, string> | null = null;
	if (chat.type === 0 && currentMemberIds.length > 0) {
		const users = await db
			.select({ id: schema.users.id, displayName: schema.users.displayName })
			.from(schema.users)
			.where(inArray(schema.users.id, currentMemberIds));
		displayNameMap = new Map(users.map((u) => [u.id, u.displayName]));
	}
	const t3 = performance.now();
	const lastReadMap = new Map(allMemberships.map((m) => [m.userId, m.lastReadAt]));

	const msgTimeMs = msgTime.getTime();
	const unreadCounts = await Promise.all(
		nonSenderMembers.map(async (memberId) => {
			const lastRead = lastReadMap.get(memberId);
			if (lastRead && lastRead >= msgTime) {
				const currentCount = await unread.get(memberId, chatId);
				return { memberId, newCount: currentCount };
			}
			const newCount = await unread.incrementIfUnread(memberId, chatId, msgTimeMs);
			return { memberId, newCount };
		}),
	);
	const t4 = performance.now();
	const unreadMap = new Map(unreadCounts.map(({ memberId, newCount }) => [memberId, newCount]));

	const inboxUpdates: Promise<void>[] = [];

	for (const memberId of currentMemberIds) {
		let chatName = chat.name;
		let otherUserId: string | null = null;

		if (chat.type === 0) {
			otherUserId = currentMemberIds.find((id) => id !== memberId) ?? null;
			if (otherUserId && displayNameMap) {
				chatName = displayNameMap.get(otherUserId) ?? "Unknown";
			}
		}

		inboxUpdates.push(
			scyllaQueries.upsertInboxEntry(
				memberId,
				{
					chatId,
					chatType: chat.type as ChatType,
					chatName,
					chatAvatar: chat.avatarUrl,
					otherUserId,
					lastMsgSender: senderId,
					lastMsgType: messageType,
					lastMsgPreview: messagePreview,
					lastActivity,
				},
				unreadMap.get(memberId) ?? 0,
			),
		);
	}

	await Promise.all(inboxUpdates);
	const t5 = performance.now();

	console.log(
		`[InboxFanout] chat=${chatId.slice(0, 8)} members=${currentMemberIds.length} lag=${lag}ms | pg=${(t2 - t1).toFixed(0)}ms names=${(t3 - t2).toFixed(0)}ms unread=${(t4 - t3).toFixed(0)}ms scylla=${(t5 - t4).toFixed(0)}ms total=${(t5 - t0).toFixed(0)}ms`,
	);
}
