import type { Message } from "./message";

export type ClientEvent =
	| { event: "message:send"; data: SendMessagePayload }
	| { event: "message:edit"; data: EditMessagePayload }
	| { event: "message:delete"; data: DeleteMessagePayload }
	| { event: "message:read"; data: ReadMessagePayload }
	| { event: "typing:start"; data: TypingPayload }
	| { event: "typing:stop"; data: TypingPayload }
	| { event: "ping" };

export type ServerEvent =
	| { event: "message:new"; data: Message }
	| { event: "message:updated"; data: MessageUpdatedPayload }
	| { event: "message:deleted"; data: MessageDeletedPayload }
	| { event: "message:status"; data: MessageStatusPayload }
	| { event: "message:ack"; data: MessageAckPayload }
	| { event: "typing"; data: TypingEventPayload }
	| { event: "presence"; data: PresenceEventPayload }
	| { event: "chat:updated"; data: ChatUpdatedPayload }
	| { event: "pong" }
	| { event: "error"; data: ErrorPayload };

export interface SendMessagePayload {
	chatId: string;
	type: number;
	content: string;
	attachments?: { url: string; type: number; filename?: string; size: number; mimeType: string }[];
	mediaGroupId?: string;
	replyTo?: string;
	clientId: string;
}

export interface EditMessagePayload {
	messageId: string;
	chatId: string;
	content: string;
}

export interface DeleteMessagePayload {
	messageId: string;
	chatId: string;
}

export interface ReadMessagePayload {
	chatId: string;
	messageId: string;
}

export interface TypingPayload {
	chatId: string;
}

export interface MessageUpdatedPayload {
	messageId: string;
	chatId: string;
	content: string;
	editedAt: string;
}

export interface MessageDeletedPayload {
	messageId: string;
	chatId: string;
}

export interface MessageStatusPayload {
	messageId: string;
	chatId: string;
	userId: string;
	status: number;
}

export interface MessageAckPayload {
	clientId: string;
	messageId: string;
	createdAt: string;
}

export interface TypingEventPayload {
	chatId: string;
	userId: string;
	isTyping: boolean;
}

export interface PresenceEventPayload {
	userId: string;
	status: "online" | "offline";
	lastSeen: string | null;
}

export interface ChatUpdatedPayload {
	chatId: string;
	lastMessage: {
		senderId: string;
		type: number;
		preview: string;
		createdAt: string;
	} | null;
	unreadCount: number;
}

export interface ErrorPayload {
	code: string;
	message: string;
}
