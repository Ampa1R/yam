import type { ChatRole, ChatType } from "../constants";

export interface Chat {
	id: string;
	type: ChatType;
	name: string | null;
	description: string | null;
	avatarUrl: string | null;
	createdBy: string | null;
	memberCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface ChatMember {
	chatId: string;
	userId: string;
	role: ChatRole;
	isPinned: boolean;
	isMuted: boolean;
	lastReadAt: string | null;
	joinedAt: string;
}

export interface InboxItem {
	chatId: string;
	chatType: ChatType;
	chatName: string | null;
	chatAvatar: string | null;
	otherUserId: string | null;
	lastMsgSender: string | null;
	lastMsgType: number | null;
	lastMsgPreview: string | null;
	lastActivity: string;
	unreadCount: number;
	isPinned: boolean;
	isMuted: boolean;
}
