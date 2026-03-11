import { Limits } from "@yam/shared";
import { db, eq, schema } from "../pg";
import { redis } from "./client";

const CHAT_MEMBERS_PREFIX = "chat:members:";
const DIRECT_CHAT_PREFIX = "direct:";
const DIRECT_CHAT_TTL = 7 * 24 * 3600; // 7 days

export const chatMembersCache = {
	async get(chatId: string): Promise<string[] | null> {
		const members = await redis.smembers(`${CHAT_MEMBERS_PREFIX}${chatId}`);
		return members.length > 0 ? members : null;
	},

	async set(chatId: string, memberIds: string[]): Promise<void> {
		const key = `${CHAT_MEMBERS_PREFIX}${chatId}`;
		const multi = redis.multi();
		multi.del(key);
		if (memberIds.length > 0) {
			multi.sadd(key, ...memberIds);
			multi.expire(key, Limits.CHAT_MEMBERS_CACHE_TTL_SECONDS);
		}
		await multi.exec();
	},

	async invalidate(chatId: string): Promise<void> {
		await redis.del(`${CHAT_MEMBERS_PREFIX}${chatId}`);
	},
};

export async function getChatMemberIds(chatId: string): Promise<string[]> {
	const cached = await chatMembersCache.get(chatId);
	if (cached) return cached;

	const members = await db
		.select({ userId: schema.chatMembers.userId })
		.from(schema.chatMembers)
		.where(eq(schema.chatMembers.chatId, chatId));

	const ids = members.map((m) => m.userId);
	await chatMembersCache.set(chatId, ids);
	return ids;
}

export const directChatLookup = {
	key(userA: string, userB: string): string {
		const sorted = [userA, userB].sort();
		return `${DIRECT_CHAT_PREFIX}${sorted[0]}:${sorted[1]}`;
	},

	async get(userA: string, userB: string): Promise<string | null> {
		return redis.get(this.key(userA, userB));
	},

	async set(userA: string, userB: string, chatId: string): Promise<void> {
		await redis.set(this.key(userA, userB), chatId, "EX", DIRECT_CHAT_TTL);
	},

	async delete(userA: string, userB: string): Promise<void> {
		await redis.del(this.key(userA, userB));
	},
};
