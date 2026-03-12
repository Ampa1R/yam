import type { Message } from "@yam/shared";

export interface ChatDetailMember {
	userId: string;
	role: number;
	isPinned: boolean;
	isMuted: boolean;
	joinedAt?: string;
	user: {
		id: string;
		displayName: string;
		username: string | null;
		avatarUrl: string | null;
	};
	isOnline?: boolean;
}

export interface ChatDetail {
	chat: {
		id: string;
		type: number;
		name: string | null;
		description: string | null;
		avatarUrl: string | null;
		createdBy: string;
		memberCount: number;
	};
	members: ChatDetailMember[];
	myMembership: unknown;
}

export interface MessagesPage {
	messages: Message[];
	nextCursor: string | null;
}

export function estimateMessageSize(message: Message): number {
	if (message.isDeleted) return 44;

	let height = 56;

	if (message.replyTo) height += 30;
	if (message.attachments.length > 0) {
		const imageCount = message.attachments.filter((a) => a.mimeType.startsWith("image/")).length;
		const fileCount = message.attachments.length - imageCount;
		if (imageCount > 0) {
			height += imageCount > 1 ? 200 : 160;
		}
		if (fileCount > 0) {
			height += fileCount * 42;
		}
	}

	if (message.content) {
		const charsPerLine = 34;
		const lineHeight = 20;
		height += Math.max(1, Math.ceil(message.content.length / charsPerLine)) * lineHeight;
	}

	return Math.min(520, Math.max(52, height));
}
