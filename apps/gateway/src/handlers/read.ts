import { and, db, eq, schema } from "@yam/db/pg";
import { publishToUsers, unread } from "@yam/db/redis";
import { scyllaQueries } from "@yam/db/scylla";
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

	await scyllaQueries.updateMessageStatus(data.chatId, data.messageId, userId, MessageStatus.READ);

	await scyllaQueries.resetInboxUnread(userId, data.chatId);
	await unread.reset(userId, data.chatId);

	await db
		.update(schema.chatMembers)
		.set({ lastReadAt: new Date() })
		.where(and(eq(schema.chatMembers.chatId, data.chatId), eq(schema.chatMembers.userId, userId)));

	const event: ServerEvent = {
		event: "message:status",
		data: {
			messageId: data.messageId,
			chatId: data.chatId,
			userId,
			status: MessageStatus.READ,
		},
	};

	const others = memberIds.filter((id) => id !== userId);
	connectionManager.sendToUsers(
		others.filter((id) => connectionManager.isLocal(id)),
		event,
	);
	await publishToUsers(
		others.filter((id) => !connectionManager.isLocal(id)),
		event,
	);
}
