import { publishToUsers, queues, rateLimit } from "@yam/db/redis";
import { scyllaQueries } from "@yam/db/scylla";
import type {
	DeleteMessagePayload,
	EditMessagePayload,
	SendMessagePayload,
	ServerEvent,
} from "@yam/shared";
import { Limits } from "@yam/shared";
import { connectionManager } from "../connection/manager";
import { getChatMemberIds } from "../lib/chat-members";

export async function handleSendMessage(userId: string, data: SendMessagePayload): Promise<void> {
	const allowed = await rateLimit.check(`${userId}:msg`, Limits.RATE_LIMIT_MESSAGES_PER_MIN, 60);
	if (!allowed) {
		connectionManager.sendToUser(userId, {
			event: "error",
			data: { code: "RATE_LIMITED", message: "Message rate limit exceeded" },
		});
		return;
	}

	const memberIds = await getChatMemberIds(data.chatId);
	if (!memberIds.includes(userId)) {
		connectionManager.sendToUser(userId, {
			event: "error",
			data: { code: "FORBIDDEN", message: "Not a member of this chat" },
		});
		return;
	}

	const attachments = data.attachments?.map((a) => ({
		type: a.type,
		url: a.url,
		filename: a.filename ?? null,
		size: a.size,
		mimeType: a.mimeType,
		width: null,
		height: null,
		duration: null,
		waveform: null,
	}));

	const message = await scyllaQueries.insertMessage({
		chatId: data.chatId,
		senderId: userId,
		type: data.type,
		content: data.content,
		replyTo: data.replyTo,
		mediaGroupId: data.mediaGroupId,
		attachments,
	});

	connectionManager.sendToUser(userId, {
		event: "message:ack",
		data: {
			clientId: data.clientId,
			messageId: message.id,
			createdAt: message.createdAt,
		},
	});

	const otherMembers = memberIds.filter((id) => id !== userId);

	const localRecipients: string[] = [];
	const remoteRecipients: string[] = [];

	for (const memberId of otherMembers) {
		if (connectionManager.isLocal(memberId)) {
			localRecipients.push(memberId);
		} else {
			remoteRecipients.push(memberId);
		}
	}

	const newMsgEvent: ServerEvent = { event: "message:new", data: message };

	connectionManager.sendToUsers(localRecipients, newMsgEvent);

	if (remoteRecipients.length > 0) {
		await publishToUsers(remoteRecipients, newMsgEvent);
	}

	const preview = (data.content || "").slice(0, Limits.INBOX_PREVIEW_LENGTH);
	await queues.inboxFanout.add({
		chatId: data.chatId,
		senderId: userId,
		messageType: data.type,
		messagePreview: preview,
		memberIds,
	});
}

export async function handleEditMessage(userId: string, data: EditMessagePayload): Promise<void> {
	const now = new Date();
	const bucket = now.getFullYear() * 100 + (now.getMonth() + 1);

	await scyllaQueries.editMessage(data.chatId, data.messageId, bucket, data.content);

	const memberIds = await getChatMemberIds(data.chatId);
	const event: ServerEvent = {
		event: "message:updated",
		data: {
			messageId: data.messageId,
			chatId: data.chatId,
			content: data.content,
			editedAt: now.toISOString(),
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

export async function handleDeleteMessage(
	userId: string,
	data: DeleteMessagePayload,
): Promise<void> {
	const now = new Date();
	const bucket = now.getFullYear() * 100 + (now.getMonth() + 1);

	await scyllaQueries.softDeleteMessage(data.chatId, data.messageId, bucket);

	const memberIds = await getChatMemberIds(data.chatId);
	const event: ServerEvent = {
		event: "message:deleted",
		data: { messageId: data.messageId, chatId: data.chatId },
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
