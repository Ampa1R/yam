import { publishToUsers, typing } from "@yam/db/redis";
import type { ServerEvent, TypingPayload } from "@yam/shared";
import { connectionManager } from "../connection/manager";
import { getChatMemberIds } from "../lib/chat-members";

function isValidTypingPayload(data: unknown): data is TypingPayload {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	return typeof d.chatId === "string" && d.chatId.length > 0;
}

export async function handleTypingStart(userId: string, data: unknown): Promise<void> {
	if (!isValidTypingPayload(data)) return;

	await typing.start(data.chatId, userId);

	const memberIds = await getChatMemberIds(data.chatId);
	const event: ServerEvent = {
		event: "typing",
		data: { chatId: data.chatId, userId, isTyping: true },
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

export async function handleTypingStop(userId: string, data: unknown): Promise<void> {
	if (!isValidTypingPayload(data)) return;

	await typing.stop(data.chatId, userId);

	const memberIds = await getChatMemberIds(data.chatId);
	const event: ServerEvent = {
		event: "typing",
		data: { chatId: data.chatId, userId, isTyping: false },
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
