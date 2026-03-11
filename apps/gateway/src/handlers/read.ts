import { and, db, eq, schema } from "@yam/db/pg";
import { publishToUsers, unread } from "@yam/db/redis";
import { scyllaQueries } from "@yam/db/scylla";
import { randomUUID } from "node:crypto";
import type { ReadMessagePayload, ServerEvent } from "@yam/shared";
import { MessageStatus } from "@yam/shared";
import { connectionManager } from "../connection/manager";
import { getChatMemberIds } from "../lib/chat-members";

function isValidReadPayload(data: unknown): data is ReadMessagePayload {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	return (
		typeof d.chatId === "string" &&
		d.chatId.length > 0 &&
		typeof d.messageId === "string" &&
		d.messageId.length > 0
	);
}

export async function handleReadMessage(userId: string, data: unknown): Promise<void> {
	if (!isValidReadPayload(data)) return;

	const memberIds = await getChatMemberIds(data.chatId);
	if (!memberIds.includes(userId)) return;

	const readUpToDate = scyllaQueries.timeuuidDate(data.messageId);
	const MAX_READ_BATCH = 500;
	const messagesToMark: Awaited<ReturnType<typeof scyllaQueries.getMessages>> = [];
	let cursor: string | undefined;
	let total = 0;

	while (total < MAX_READ_BATCH) {
		const batch = await scyllaQueries.getMessages(data.chatId, 100, cursor);
		if (batch.length === 0) break;

		let foundOlder = false;
		for (const m of batch) {
			if (new Date(m.createdAt) > readUpToDate) continue;
			if (m.senderId !== userId && !m.isDeleted) {
				messagesToMark.push(m);
				total++;
			}
			if (total >= MAX_READ_BATCH) break;
		}
		const lastMsg = batch[batch.length - 1];
		if (lastMsg && new Date(lastMsg.createdAt) < readUpToDate) {
			foundOlder = true;
		}
		if (batch.length < 100 || foundOlder) break;
		cursor = batch[batch.length - 1]?.id;
	}

	await Promise.all(
		messagesToMark.map((m) =>
			scyllaQueries.updateMessageStatusMonotonic(
				data.chatId,
				m.id,
				userId,
				MessageStatus.READ,
			),
		),
	);

	await db
		.update(schema.chatMembers)
		.set({ lastReadAt: new Date() })
		.where(and(eq(schema.chatMembers.chatId, data.chatId), eq(schema.chatMembers.userId, userId)));

	await unread.reset(userId, data.chatId);
	await scyllaQueries.resetInboxUnread(userId, data.chatId);

	const others = memberIds.filter((id) => id !== userId);
	const localOthers = others.filter((id) => connectionManager.isLocal(id));
	const remoteOthers = others.filter((id) => !connectionManager.isLocal(id));

	for (const msg of messagesToMark) {
		const event: ServerEvent = {
			event: "message:status",
			data: {
				messageId: msg.id,
				chatId: data.chatId,
				userId,
				status: MessageStatus.READ,
			},
			eventId: randomUUID(),
		};
		connectionManager.sendToUsers(localOthers, event);
		if (remoteOthers.length > 0) {
			await publishToUsers(remoteOthers, event);
		}
	}
}
