import { and, db, eq, schema } from "@yam/db/pg";
import { publishToUsers, queues, rateLimit, userConnections } from "@yam/db/redis";
import { scyllaQueries } from "@yam/db/scylla";
import { randomUUID } from "node:crypto";
import type {
	Attachment,
	DeleteMessagePayload,
	EditMessagePayload,
	SendMessagePayload,
	ServerEvent,
} from "@yam/shared";
import { type ChatType, Limits, MessageStatus, MessageType } from "@yam/shared";
import { connectionManager } from "../connection/manager";
import { getChatMemberIds } from "../lib/chat-members";

type ErrorSeverity = "info" | "warning" | "error";
type ErrorScope = "auth" | "chat" | "message" | "system";

const MSG_ERROR_DEFAULTS: Record<string, { severity: ErrorSeverity; retryable: boolean; scope: ErrorScope }> = {
	INVALID_PAYLOAD: { severity: "warning", retryable: false, scope: "message" },
	MESSAGE_TOO_LONG: { severity: "warning", retryable: false, scope: "message" },
	INVALID_TYPE: { severity: "warning", retryable: false, scope: "message" },
	RATE_LIMITED: { severity: "warning", retryable: true, scope: "message" },
	FORBIDDEN: { severity: "error", retryable: false, scope: "chat" },
	BLOCKED: { severity: "error", retryable: false, scope: "chat" },
	NOT_FOUND: { severity: "error", retryable: false, scope: "message" },
	GONE: { severity: "error", retryable: false, scope: "message" },
};

function sendError(userId: string, code: string, message: string): void {
	const defaults = MSG_ERROR_DEFAULTS[code] ?? { severity: "error", retryable: false, scope: "message" };
	connectionManager.sendToUser(userId, {
		event: "error",
		data: {
			code,
			message,
			severity: defaults.severity,
			retryable: defaults.retryable,
			scope: defaults.scope,
		},
		eventId: randomUUID(),
	});
}

function splitLocalRemote(memberIds: string[]) {
	const local: string[] = [];
	const remote: string[] = [];
	for (const id of memberIds) {
		(connectionManager.isLocal(id) ? local : remote).push(id);
	}
	return { local, remote };
}

async function broadcastToMembers(memberIds: string[], event: ServerEvent): Promise<void> {
	const { local, remote } = splitLocalRemote(memberIds);
	connectionManager.sendToUsers(local, event);
	if (remote.length > 0) await publishToUsers(remote, event);
}

function buildInboxPreview(msg: { senderId: string; type: number; content: string; createdAt: string }) {
	return {
		senderId: msg.senderId,
		type: msg.type,
		preview: (msg.content || "").slice(0, Limits.INBOX_PREVIEW_LENGTH),
		createdAt: msg.createdAt,
	};
}

function getPreviewText(content: string, type: number, attachments?: unknown[]): string {
	if (content) return content.slice(0, Limits.INBOX_PREVIEW_LENGTH);
	if (type === MessageType.VOICE) return "🎤 Voice message";
	if (attachments && attachments.length > 0) return "📎 Attachment";
	return "";
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

async function checkBlockedInDirect(
	userId: string,
	memberIds: string[],
	chatType: number | undefined,
): Promise<boolean> {
	if (chatType !== 0) return false;
	const otherId = memberIds.find((id) => id !== userId);
	if (!otherId) return false;

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
	return !!blocked;
}

async function canDeleteOthersMessage(userId: string, chatId: string): Promise<boolean> {
	const memberIds = await getChatMemberIds(chatId);
	if (!memberIds.includes(userId)) return false;

	const [membership] = await db
		.select({ role: schema.chatMembers.role })
		.from(schema.chatMembers)
		.where(
			and(
				eq(schema.chatMembers.chatId, chatId),
				eq(schema.chatMembers.userId, userId),
			),
		)
		.limit(1);

	return !!membership && membership.role >= 1;
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
	if (data.type < MessageType.TEXT || data.type > MessageType.VOICE) {
		sendError(userId, "INVALID_TYPE", "Invalid message type");
		return;
	}
	if (data.attachments && data.attachments.length > 10) {
		sendError(userId, "INVALID_PAYLOAD", "Maximum 10 attachments per message");
		return;
	}
	if (data.attachments?.some((a) => typeof a.url === "string" && !a.url.startsWith("/api/files/"))) {
		sendError(userId, "INVALID_PAYLOAD", "Invalid attachment URL");
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

	if (await checkBlockedInDirect(userId, memberIds, chat?.type)) {
		sendError(userId, "BLOCKED", "You cannot send messages to this user");
		return;
	}

	const attachments: Attachment[] | undefined = data.attachments?.map((a) => ({
		type: a.type as Attachment["type"],
		url: a.url,
		filename: a.filename ?? null,
		size: a.size,
		mimeType: a.mimeType,
		width: null,
		height: null,
		duration: a.duration ?? null,
		waveform: a.waveform ?? null,
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
		eventId: randomUUID(),
	});

	const otherMembers = memberIds.filter((id) => id !== userId);

	const newMsgEvent: ServerEvent = {
		event: "message:new",
		data: { ...message, chatType: chat?.type as ChatType },
		eventId: randomUUID(),
	};
	await broadcastToMembers(otherMembers, newMsgEvent);

	for (const memberId of otherMembers) {
		const isOnline = connectionManager.isLocal(memberId) || (await userConnections.isConnected(memberId));
		if (!isOnline) continue;
		await scyllaQueries.updateMessageStatusMonotonic(
			data.chatId,
			message.id,
			memberId,
			MessageStatus.DELIVERED,
		);
		connectionManager.sendToUser(userId, {
			event: "message:status",
			data: {
				messageId: message.id,
				chatId: data.chatId,
				userId: memberId,
				status: MessageStatus.DELIVERED,
			},
			eventId: randomUUID(),
		});
	}

	const preview = getPreviewText(data.content, data.type, attachments);
	await queues.inboxFanout.add({
		chatId: data.chatId,
		senderId: userId,
		messageType: data.type,
		messagePreview: preview,
		createdAt: message.createdAt,
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
	await broadcastToMembers(memberIds, {
		event: "message:updated",
		data: { messageId: data.messageId, chatId: data.chatId, content: data.content, editedAt },
		eventId: randomUUID(),
	});

	const [latestMsg] = await scyllaQueries.getMessages(data.chatId, 1);
	if (latestMsg && latestMsg.id === data.messageId) {
		await broadcastToMembers(memberIds, {
			event: "chat:updated",
			data: {
				chatId: data.chatId,
				lastMessage: buildInboxPreview({ ...existing, content: data.content }),
				unreadCount: -1,
			},
			eventId: randomUUID(),
		});
	}
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
		if (!(await canDeleteOthersMessage(userId, data.chatId))) {
			sendError(userId, "FORBIDDEN", "You can only delete your own messages");
			return;
		}
	}

	await scyllaQueries.softDeleteMessage(data.chatId, data.messageId, bucket);

	const memberIds = await getChatMemberIds(data.chatId);
	await broadcastToMembers(memberIds, {
		event: "message:deleted",
		data: { messageId: data.messageId, chatId: data.chatId },
		eventId: randomUUID(),
	});

	const recent = await scyllaQueries.getMessages(data.chatId, 3);
	const latestActive = recent.find((m) => !m.isDeleted && m.id !== data.messageId);
	await broadcastToMembers(memberIds, {
		event: "chat:updated",
		data: {
			chatId: data.chatId,
			lastMessage: latestActive ? buildInboxPreview(latestActive) : null,
			unreadCount: -1,
		},
		eventId: randomUUID(),
	});
}
