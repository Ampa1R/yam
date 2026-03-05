export const ChatType = {
	DIRECT: 0,
	GROUP: 1,
} as const;
export type ChatType = (typeof ChatType)[keyof typeof ChatType];

export const ChatRole = {
	MEMBER: 0,
	ADMIN: 1,
	OWNER: 2,
} as const;
export type ChatRole = (typeof ChatRole)[keyof typeof ChatRole];

export const MessageType = {
	TEXT: 0,
	MEDIA: 1,
	DOCUMENT: 2,
	VOICE: 3,
	STICKER: 4,
	SYSTEM: 5,
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const AttachmentType = {
	IMAGE: 0,
	VIDEO: 1,
	DOCUMENT: 2,
	VOICE: 3,
} as const;
export type AttachmentType = (typeof AttachmentType)[keyof typeof AttachmentType];

export const MessageStatus = {
	SENT: 0,
	DELIVERED: 1,
	READ: 2,
} as const;
export type MessageStatus = (typeof MessageStatus)[keyof typeof MessageStatus];

export const UserRole = {
	USER: 0,
	MODERATOR: 1,
	ADMIN: 2,
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const Platform = {
	WEB: 0,
	IOS: 1,
	ANDROID: 2,
} as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

export const Limits = {
	MAX_GROUP_SIZE: 200,
	MAX_MESSAGE_LENGTH: 4096,
	MAX_FILE_SIZE_MB: 50,
	MAX_DISPLAY_NAME_LENGTH: 100,
	MAX_STATUS_LENGTH: 200,
	MAX_USERNAME_LENGTH: 50,
	MAX_CHAT_NAME_LENGTH: 200,
	RATE_LIMIT_MESSAGES_PER_MIN: 60,
	RATE_LIMIT_OTP_PER_HOUR: 5,
	OTP_TTL_SECONDS: 300,
	PRESENCE_TTL_SECONDS: 30,
	TYPING_TTL_SECONDS: 3,
	HEARTBEAT_INTERVAL_MS: 25_000,
	CHAT_MEMBERS_CACHE_TTL_SECONDS: 300,
	INBOX_PREVIEW_LENGTH: 100,
	DEFAULT_PAGE_SIZE: 50,
	MAX_PAGE_SIZE: 100,
} as const;
