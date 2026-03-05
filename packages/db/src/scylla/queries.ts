import type { Attachment, InboxItem, Message, MessageType } from "@yam/shared";
import { types } from "cassandra-driver";
import { scyllaClient } from "./client";

function currentBucket(): number {
	const d = new Date();
	return d.getFullYear() * 100 + (d.getMonth() + 1);
}

export function bucketFromTimeuuid(timeuuidStr: string): number {
	const d = types.TimeUuid.fromString(timeuuidStr).getDate();
	return d.getFullYear() * 100 + (d.getMonth() + 1);
}

function timeuuidToDate(timeuuid: types.TimeUuid): Date {
	return timeuuid.getDate();
}

function rowToMessage(row: types.Row): Message {
	return {
		id: row.id.toString(),
		chatId: row.chat_id.toString(),
		bucket: row.bucket,
		senderId: row.sender_id.toString(),
		type: row.type,
		content: row.content ?? "",
		attachments: (row.attachments ?? []).map((a: Record<string, unknown>) => ({
			type: a.type,
			url: a.url,
			filename: a.filename,
			size: a.size,
			mimeType: a.mime_type,
			width: a.width,
			height: a.height,
			duration: a.duration,
			waveform: a.waveform ? Array.from(a.waveform as Buffer) : null,
		})),
		mediaGroupId: row.media_group_id?.toString() ?? null,
		replyTo: row.reply_to?.toString() ?? null,
		isEdited: row.is_edited ?? false,
		isDeleted: row.is_deleted ?? false,
		createdAt: timeuuidToDate(row.id).toISOString(),
		editedAt: row.edited_at?.toISOString() ?? null,
	};
}

export async function insertMessage(params: {
	chatId: string;
	senderId: string;
	type: number;
	content: string;
	attachments?: Attachment[];
	mediaGroupId?: string;
	replyTo?: string;
}): Promise<Message> {
	const bucket = currentBucket();
	const id = types.TimeUuid.now();
	const now = new Date();

	const scyllaAttachments = (params.attachments ?? []).map((a) => ({
		type: a.type,
		url: a.url,
		filename: a.filename,
		size: a.size,
		mime_type: a.mimeType,
		width: a.width,
		height: a.height,
		duration: a.duration,
		waveform: a.waveform ? Buffer.from(a.waveform) : null,
	}));

	await scyllaClient.execute(
		`INSERT INTO messages (chat_id, bucket, id, sender_id, type, content, attachments, media_group_id, reply_to, is_edited, is_deleted, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, false, false, ?)`,
		[
			types.Uuid.fromString(params.chatId),
			bucket,
			id,
			types.Uuid.fromString(params.senderId),
			params.type,
			params.content,
			scyllaAttachments.length > 0 ? scyllaAttachments : null,
			params.mediaGroupId ? types.Uuid.fromString(params.mediaGroupId) : null,
			params.replyTo ? types.TimeUuid.fromString(params.replyTo) : null,
			now,
		],
		{ prepare: true },
	);

	return {
		id: id.toString(),
		chatId: params.chatId,
		bucket,
		senderId: params.senderId,
		type: params.type as MessageType,
		content: params.content,
		attachments: params.attachments ?? [],
		mediaGroupId: params.mediaGroupId ?? null,
		replyTo: params.replyTo ?? null,
		isEdited: false,
		isDeleted: false,
		createdAt: now.toISOString(),
		editedAt: null,
	};
}

export async function getMessages(
	chatId: string,
	limit: number = 50,
	beforeId?: string,
): Promise<Message[]> {
	const chatUuid = types.Uuid.fromString(chatId);
	let currentBkt = beforeId ? bucketFromTimeuuid(beforeId) : currentBucket();

	let messages: Message[] = [];
	const maxBucketsToScan = 12;
	let usedBeforeId = false;

	for (let i = 0; i < maxBucketsToScan && messages.length < limit; i++) {
		let query: string;
		let queryParams: unknown[];

		if (beforeId && !usedBeforeId) {
			query = `SELECT * FROM messages WHERE chat_id = ? AND bucket = ? AND id < ? ORDER BY id DESC LIMIT ?`;
			queryParams = [chatUuid, currentBkt, types.TimeUuid.fromString(beforeId), limit];
			usedBeforeId = true;
		} else {
			query = `SELECT * FROM messages WHERE chat_id = ? AND bucket = ? ORDER BY id DESC LIMIT ?`;
			queryParams = [chatUuid, currentBkt, limit - messages.length];
		}

		const result = await scyllaClient.execute(query, queryParams, { prepare: true });
		const batchMessages = result.rows.map(rowToMessage);
		messages = messages.concat(batchMessages);

		if (messages.length >= limit) break;

		const year = Math.floor(currentBkt / 100);
		const month = currentBkt % 100;
		if (month === 1) {
			currentBkt = (year - 1) * 100 + 12;
		} else {
			currentBkt = year * 100 + (month - 1);
		}
	}

	return messages.slice(0, limit);
}

export async function getMessage(
	chatId: string,
	messageId: string,
	bucket: number,
): Promise<Message | null> {
	const result = await scyllaClient.execute(
		`SELECT * FROM messages WHERE chat_id = ? AND bucket = ? AND id = ? LIMIT 1`,
		[types.Uuid.fromString(chatId), bucket, types.TimeUuid.fromString(messageId)],
		{ prepare: true },
	);
	if (result.rows.length === 0) return null;
	return rowToMessage(result.rows[0]!);
}

export async function editMessage(
	chatId: string,
	messageId: string,
	bucket: number,
	content: string,
): Promise<void> {
	await scyllaClient.execute(
		`UPDATE messages SET content = ?, is_edited = true, edited_at = ? WHERE chat_id = ? AND bucket = ? AND id = ?`,
		[
			content,
			new Date(),
			types.Uuid.fromString(chatId),
			bucket,
			types.TimeUuid.fromString(messageId),
		],
		{ prepare: true },
	);
}

export async function softDeleteMessage(
	chatId: string,
	messageId: string,
	bucket: number,
): Promise<void> {
	await scyllaClient.execute(
		`UPDATE messages SET is_deleted = true, content = '', attachments = null WHERE chat_id = ? AND bucket = ? AND id = ?`,
		[types.Uuid.fromString(chatId), bucket, types.TimeUuid.fromString(messageId)],
		{ prepare: true },
	);
}

export async function updateMessageStatus(
	chatId: string,
	messageId: string,
	userId: string,
	status: number,
): Promise<void> {
	await scyllaClient.execute(
		`INSERT INTO message_status (chat_id, message_id, user_id, status, updated_at) VALUES (?, ?, ?, ?, ?)`,
		[
			types.Uuid.fromString(chatId),
			types.TimeUuid.fromString(messageId),
			types.Uuid.fromString(userId),
			status,
			new Date(),
		],
		{ prepare: true },
	);
}

export async function getInbox(userId: string): Promise<InboxItem[]> {
	const result = await scyllaClient.execute(
		`SELECT * FROM user_inbox WHERE user_id = ?`,
		[types.Uuid.fromString(userId)],
		{ prepare: true },
	);

	return result.rows
		.map((row) => ({
			chatId: row.chat_id.toString(),
			chatType: row.chat_type,
			chatName: row.chat_name,
			chatAvatar: row.chat_avatar,
			otherUserId: row.other_user_id?.toString() ?? null,
			lastMsgSender: row.last_msg_sender?.toString() ?? null,
			lastMsgType: row.last_msg_type ?? null,
			lastMsgPreview: row.last_msg_preview ?? null,
			lastActivity: row.last_activity?.toISOString() ?? new Date().toISOString(),
			unreadCount: row.unread_count ?? 0,
			isPinned: row.is_pinned ?? false,
			isMuted: row.is_muted ?? false,
		}))
		.sort((a, b) => {
			if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
			return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
		});
}

export async function upsertInboxEntry(
	userId: string,
	entry: Omit<InboxItem, "unreadCount" | "isPinned" | "isMuted">,
	incrementUnread: boolean = false,
): Promise<void> {
	if (incrementUnread) {
		await scyllaClient.execute(
			`UPDATE user_inbox SET
				chat_type = ?, chat_name = ?, chat_avatar = ?, other_user_id = ?,
				last_msg_sender = ?, last_msg_type = ?, last_msg_preview = ?,
				last_activity = ?, unread_count = unread_count + 1
			 WHERE user_id = ? AND chat_id = ?`,
			[
				entry.chatType,
				entry.chatName,
				entry.chatAvatar,
				entry.otherUserId ? types.Uuid.fromString(entry.otherUserId) : null,
				entry.lastMsgSender ? types.Uuid.fromString(entry.lastMsgSender) : null,
				entry.lastMsgType,
				entry.lastMsgPreview,
				new Date(entry.lastActivity),
				types.Uuid.fromString(userId),
				types.Uuid.fromString(entry.chatId),
			],
			{ prepare: true },
		);
	} else {
		await scyllaClient.execute(
			`UPDATE user_inbox SET
				chat_type = ?, chat_name = ?, chat_avatar = ?, other_user_id = ?,
				last_msg_sender = ?, last_msg_type = ?, last_msg_preview = ?,
				last_activity = ?, unread_count = 0
			 WHERE user_id = ? AND chat_id = ?`,
			[
				entry.chatType,
				entry.chatName,
				entry.chatAvatar,
				entry.otherUserId ? types.Uuid.fromString(entry.otherUserId) : null,
				entry.lastMsgSender ? types.Uuid.fromString(entry.lastMsgSender) : null,
				entry.lastMsgType,
				entry.lastMsgPreview,
				new Date(entry.lastActivity),
				types.Uuid.fromString(userId),
				types.Uuid.fromString(entry.chatId),
			],
			{ prepare: true },
		);
	}
}

export async function resetInboxUnread(userId: string, chatId: string): Promise<void> {
	await scyllaClient.execute(
		`UPDATE user_inbox SET unread_count = 0 WHERE user_id = ? AND chat_id = ?`,
		[types.Uuid.fromString(userId), types.Uuid.fromString(chatId)],
		{ prepare: true },
	);
}
