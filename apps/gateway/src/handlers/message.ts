import { and, db, eq, schema } from "@yam/db/pg";
import { publishToUsers, queues, rateLimit } from "@yam/db/redis";
import { scyllaQueries } from "@yam/db/scylla";
import type {
	Attachment,
	DeleteMessagePayload,
	EditMessagePayload,
	SendMessagePayload,
	ServerEvent,
} from "@yam/shared";
import { Limits, MessageType } from "@yam/shared";
import { connectionManager } from "../connection/manager";
import { getChatMemberIds } from "../lib/chat-members";

function sendError(userId: string, code: string, message: string): void {
	connectionManager.sendToUser(userId, {
		event: "error",
		data: { code, message },
	});
}

function isValidSendPayload(data: unknown): data is SendMessagePayload {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	return (
		typeof d.chatId === "string" &&
		d.chatId.length > 0 &&
		typeof d.type === "number" &&
		typeof d.content === "string" &&
		typeof d.clientId === "string" &&
		d.clientId.length > 0
	);
}

function isValidEditPayload(data: unknown): data is EditMessagePayload {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	return (
		typeof d.messageId === "string" &&
		d.messageId.length > 0 &&
		typeof d.chatId === "string" &&
		d.chatId.length > 0 &&
		typeof d.content === "string"
	);
}

function isValidDeletePayload(data: unknown): data is DeleteMessagePayload {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	return (
		typeof d.messageId === "string" &&
		d.messageId.length > 0 &&
		typeof d.chatId === "string" &&
		d.chatId.length > 0
	);
}

export async function handleSendMessage(userId: string, data: unknown): Promise<void> {
	if (!isValidSendPayload(data)) {
		sendError(userId, "INVALID_PAYLOAD", "Invalid message:send payload");
		return;
	}

	if (data.content.length > Limits.MAX_MESSAGE_LENGTH) {
		sendError(userId, "MESSAGE_TOO_LONG", `Message exceeds ${Limits.MAX_MESSAGE_LENGTH} characters`);
		return;
	}

	if (data.type < MessageType.TEXT || data.type > MessageType.SYSTEM) {
		sendError(userId, "INVALID_TYPE", "Invalid message type");
		return;
	}

	const allowed = await rateLimit.check(`${userId}:msg`, Limits.RATE_LIMIT_MESSAGES_PER_MIN, 60);
	if (!allowed) {
		sendError(userId, "RATE_LIMITED", "Message rate limit exceeded");
		return;
	}

	const memberIds = await getChatMemberIds(data.chatId);
	if (!memberIds.includes(userId)) {
		sendError(userId, "FORBIDDEN", "Not a member of this chat");
		return;
	}

	const [chat] = await db
		.select({ type: schema.chats.type })
		.from(schema.chats)
		.where(eq(schema.chats.id, data.chatId))
		.limit(1);

	if (chat?.type === 0) {
		const otherId = memberIds.find((id) => id !== userId);
		if (otherId) {
			const [blocked] = await db
				.select()
				.from(schema.blockedUsers)
				.where(
					and(
						eq(schema.blockedUsers.userId, otherId),
						eq(schema.blockedUsers.blockedId, userId),
					),
				)
				.limit(1);

			if (blocked) {
				sendError(userId, "BLOCKED", "You cannot send messages to this user");
				return;
			}
		}
	}

	const attachments: Attachment[] | undefined = data.attachments?.map((a) => ({
		type: a.type as Attachment["type"],
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

export async function handleEditMessage(userId: string, data: unknown): Promise<void> {
	if (!isValidEditPayload(data)) {
		sendError(userId, "INVALID_PAYLOAD", "Invalid message:edit payload");
		return;
	}

	if (data.content.length > Limits.MAX_MESSAGE_LENGTH) {
		sendError(userId, "MESSAGE_TOO_LONG", `Message exceeds ${Limits.MAX_MESSAGE_LENGTH} characters`);
		return;
	}

	const bucket = scyllaQueries.bucketFromTimeuuid(data.messageId);

	const existing = await scyllaQueries.getMessage(data.chatId, data.messageId, bucket);
	if (!existing) {
		sendError(userId, "NOT_FOUND", "Message not found");
		return;
	}
	if (existing.senderId !== userId) {
		sendError(userId, "FORBIDDEN", "You can only edit your own messages");
		return;
	}
	if (existing.isDeleted) {
		sendError(userId, "GONE", "Message has been deleted");
		return;
	}

	await scyllaQueries.editMessage(data.chatId, data.messageId, bucket, data.content);

	const memberIds = await getChatMemberIds(data.chatId);
	const editedAt = new Date().toISOString();
	const event: ServerEvent = {
		event: "message:updated",
		data: {
			messageId: data.messageId,
			chatId: data.chatId,
			content: data.content,
			editedAt,
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

export async function handleDeleteMessage(userId: string, data: unknown): Promise<void> {
	if (!isValidDeletePayload(data)) {
		sendError(userId, "INVALID_PAYLOAD", "Invalid message:delete payload");
		return;
	}

	const bucket = scyllaQueries.bucketFromTimeuuid(data.messageId);

	const existing = await scyllaQueries.getMessage(data.chatId, data.messageId, bucket);
	if (!existing) {
		sendError(userId, "NOT_FOUND", "Message not found");
		return;
	}
	if (existing.senderId !== userId) {
		const memberIds = await getChatMemberIds(data.chatId);
		if (!memberIds.includes(userId)) {
			sendError(userId, "FORBIDDEN", "Not a member of this chat");
			return;
		}
		const [membership] = await db
			.select({ role: schema.chatMembers.role })
			.from(schema.chatMembers)
			.where(
				and(
					eq(schema.chatMembers.chatId, data.chatId),
					eq(schema.chatMembers.userId, userId),
				),
			)
			.limit(1);
		if (!membership || membership.role < 1) {
			sendError(userId, "FORBIDDEN", "You can only delete your own messages");
			return;
		}
	}

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
