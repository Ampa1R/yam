import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	smallint,
	text,
	timestamp,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

export const users = pgTable(
	"users",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		phone: varchar("phone", { length: 20 }).notNull().unique(),
		username: varchar("username", { length: 50 }).unique(),
		displayName: varchar("display_name", { length: 100 }).notNull(),
		avatarUrl: text("avatar_url"),
		statusText: varchar("status_text", { length: 200 }),
		isProfilePublic: boolean("is_profile_public").notNull().default(false),
		role: smallint("role").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("idx_users_phone").on(t.phone), index("idx_users_username").on(t.username)],
);

export const contacts = pgTable(
	"contacts",
	{
		userId: uuid("user_id").notNull(),
		contactId: uuid("contact_id").notNull(),
		nickname: varchar("nickname", { length: 100 }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.contactId] }),
		index("idx_contacts_reverse").on(t.contactId, t.userId),
	],
);

export const blockedUsers = pgTable(
	"blocked_users",
	{
		userId: uuid("user_id").notNull(),
		blockedId: uuid("blocked_id").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.userId, t.blockedId] })],
);

export const chats = pgTable("chats", {
	id: uuid("id").primaryKey().defaultRandom(),
	type: smallint("type").notNull().default(0),
	name: varchar("name", { length: 200 }),
	description: text("description"),
	avatarUrl: text("avatar_url"),
	createdBy: uuid("created_by"),
	memberCount: integer("member_count").notNull().default(0),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatMembers = pgTable(
	"chat_members",
	{
		chatId: uuid("chat_id").notNull(),
		userId: uuid("user_id").notNull(),
		role: smallint("role").notNull().default(0),
		isPinned: boolean("is_pinned").notNull().default(false),
		isMuted: boolean("is_muted").notNull().default(false),
		lastReadAt: timestamp("last_read_at", { withTimezone: true }),
		joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.chatId, t.userId] }),
		index("idx_chat_members_user").on(t.userId),
	],
);

export const refreshTokens = pgTable(
	"refresh_tokens",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id").notNull(),
		tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
		deviceInfo: text("device_info"),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("idx_refresh_tokens_user").on(t.userId),
		index("idx_refresh_tokens_expires").on(t.expiresAt),
	],
);

export const deviceTokens = pgTable(
	"device_tokens",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id").notNull(),
		platform: smallint("platform").notNull(),
		token: text("token").notNull().unique(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("idx_device_tokens_user").on(t.userId)],
);

export const files = pgTable(
	"files",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		uploaderId: uuid("uploader_id").notNull(),
		filename: varchar("filename", { length: 255 }).notNull(),
		mimeType: varchar("mime_type", { length: 100 }).notNull(),
		size: integer("size").notNull(),
		storageKey: text("storage_key").notNull(),
		width: smallint("width"),
		height: smallint("height"),
		duration: integer("duration"),
		waveform: jsonb("waveform"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("idx_files_uploader").on(t.uploaderId)],
);

export const systemSettings = pgTable("system_settings", {
	key: varchar("key", { length: 100 }).primaryKey(),
	value: jsonb("value").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	updatedBy: uuid("updated_by"),
});
