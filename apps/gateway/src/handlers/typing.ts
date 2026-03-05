import { publishToUsers, typing } from "@yam/db/redis";
import type { ServerEvent, TypingPayload } from "@yam/shared";
import { connectionManager } from "../connection/manager";
import { getChatMemberIds } from "../lib/chat-members";

export async function handleTypingStart(userId: string, data: TypingPayload): Promise<void> {
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

export async function handleTypingStop(userId: string, data: TypingPayload): Promise<void> {
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
