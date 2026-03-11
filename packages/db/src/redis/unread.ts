import { redis } from "./client";

const UNREAD_PREFIX = "unread:";
const LAST_READ_PREFIX = "last_read:";
const UNREAD_TTL = 30 * 24 * 3600; // 30 days

export const unread = {
	async increment(userId: string, chatId: string): Promise<number> {
		const key = `${UNREAD_PREFIX}${userId}:${chatId}`;
		const p = redis.pipeline();
		p.incr(key);
		p.expire(key, UNREAD_TTL);
		const results = await p.exec();
		return (results?.[0]?.[1] as number) ?? 0;
	},

	async incrementIfUnread(userId: string, chatId: string, msgTimeMs: number): Promise<number> {
		const readTs = await redis.get(`${LAST_READ_PREFIX}${userId}:${chatId}`);
		if (readTs && Number(readTs) >= msgTimeMs) {
			return this.get(userId, chatId);
		}
		return this.increment(userId, chatId);
	},

	async markRead(userId: string, chatId: string): Promise<void> {
		const key = `${LAST_READ_PREFIX}${userId}:${chatId}`;
		await redis.set(key, String(Date.now()), "EX", UNREAD_TTL);
	},

	async reset(userId: string, chatId: string): Promise<void> {
		const pipeline = redis.pipeline();
		pipeline.del(`${UNREAD_PREFIX}${userId}:${chatId}`);
		pipeline.set(`${LAST_READ_PREFIX}${userId}:${chatId}`, String(Date.now()), "EX", UNREAD_TTL);
		await pipeline.exec();
	},

	async get(userId: string, chatId: string): Promise<number> {
		const val = await redis.get(`${UNREAD_PREFIX}${userId}:${chatId}`);
		return val ? Number.parseInt(val, 10) : 0;
	},

	async getMultiple(userId: string, chatIds: string[]): Promise<Map<string, number>> {
		if (chatIds.length === 0) return new Map();

		const pipeline = redis.pipeline();
		for (const chatId of chatIds) {
			pipeline.get(`${UNREAD_PREFIX}${userId}:${chatId}`);
		}

		const results = await pipeline.exec();
		const map = new Map<string, number>();

		for (let i = 0; i < chatIds.length; i++) {
			const val = results?.[i]?.[1] as string | null;
			map.set(chatIds[i]!, val ? Number.parseInt(val, 10) : 0);
		}

		return map;
	},
};
