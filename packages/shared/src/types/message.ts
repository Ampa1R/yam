import type { AttachmentType, MessageType } from "../constants";

export interface Attachment {
	type: AttachmentType;
	url: string;
	filename: string | null;
	size: number;
	mimeType: string;
	width: number | null;
	height: number | null;
	duration: number | null;
	waveform: number[] | null;
}

export interface Message {
	id: string;
	chatId: string;
	bucket: number;
	senderId: string;
	type: MessageType;
	content: string;
	attachments: Attachment[];
	mediaGroupId: string | null;
	replyTo: string | null;
	isEdited: boolean;
	isDeleted: boolean;
	createdAt: string;
	editedAt: string | null;
}

export interface MessageStatusEntry {
	chatId: string;
	messageId: string;
	userId: string;
	status: number;
	updatedAt: string;
}

export interface FileUploadResult {
	id: string;
	url: string;
	filename: string;
	mimeType: string;
	size: number;
	width: number | null;
	height: number | null;
}
