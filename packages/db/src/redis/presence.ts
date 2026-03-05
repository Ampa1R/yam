import { Limits } from "@yam/shared";
import { redis } from "./client";

const PRESENCE_PREFIX = "presence:";
const LAST_SEEN_PREFIX = "last_seen:";
const TYPING_PREFIX = "typing:";
const UNREAD_PREFIX = "unread:";
const CHAT_MEMBERS_PREFIX = "chat:members:";
const DIRECT_CHAT_PREFIX = "direct:";
const OTP_PREFIX = "otp:";
const OTP_ATTEMPTS_PREFIX = "otp_attempts:";
const USER_CONNECTIONS_PREFIX = "user:connections:";
const RATE_PREFIX = "rate:";

export const presence = {
	async setOnline(userId: string): Promise<void> {
		await redis.set(`${PRESENCE_PREFIX}${userId}`, "online", "EX", Limits.PRESENCE_TTL_SECONDS);
	},

	async setOffline(userId: string): Promise<void> {
		await redis.del(`${PRESENCE_PREFIX}${userId}`);
		await redis.set(`${LAST_SEEN_PREFIX}${userId}`, new Date().toISOString());
	},

	async isOnline(userId: string): Promise<boolean> {
		const val = await redis.get(`${PRESENCE_PREFIX}${userId}`);
		return val === "online";
	},

	async getLastSeen(userId: string): Promise<string | null> {
		return redis.get(`${LAST_SEEN_PREFIX}${userId}`);
	},

	async getMultiplePresence(
		userIds: string[],
	): Promise<Map<string, { online: boolean; lastSeen: string | null }>> {
		if (userIds.length === 0) return new Map();

		const pipeline = redis.pipeline();
		for (const id of userIds) {
			pipeline.get(`${PRESENCE_PREFIX}${id}`);
			pipeline.get(`${LAST_SEEN_PREFIX}${id}`);
		}

		const results = await pipeline.exec();
		const map = new Map<string, { online: boolean; lastSeen: string | null }>();

		for (let i = 0; i < userIds.length; i++) {
			const presenceResult = results?.[i * 2]?.[1] as string | null;
			const lastSeenResult = results?.[i * 2 + 1]?.[1] as string | null;
			map.set(userIds[i]!, {
				online: presenceResult === "online",
				lastSeen: lastSeenResult,
			});
		}

		return map;
	},
};

export const typing = {
	async start(chatId: string, userId: string): Promise<void> {
		await redis.set(`${TYPING_PREFIX}${chatId}:${userId}`, "1", "EX", Limits.TYPING_TTL_SECONDS);
	},

	async stop(chatId: string, userId: string): Promise<void> {
		await redis.del(`${TYPING_PREFIX}${chatId}:${userId}`);
	},
};

export const unread = {
	async increment(userId: string, chatId: string): Promise<number> {
		return redis.incr(`${UNREAD_PREFIX}${userId}:${chatId}`);
	},

	async reset(userId: string, chatId: string): Promise<void> {
		await redis.del(`${UNREAD_PREFIX}${userId}:${chatId}`);
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

export const chatMembersCache = {
	async get(chatId: string): Promise<string[] | null> {
		const members = await redis.smembers(`${CHAT_MEMBERS_PREFIX}${chatId}`);
		return members.length > 0 ? members : null;
	},

	async set(chatId: string, memberIds: string[]): Promise<void> {
		const key = `${CHAT_MEMBERS_PREFIX}${chatId}`;
		const pipeline = redis.pipeline();
		pipeline.del(key);
		if (memberIds.length > 0) {
			pipeline.sadd(key, ...memberIds);
			pipeline.expire(key, Limits.CHAT_MEMBERS_CACHE_TTL_SECONDS);
		}
		await pipeline.exec();
	},

	async invalidate(chatId: string): Promise<void> {
		await redis.del(`${CHAT_MEMBERS_PREFIX}${chatId}`);
	},
};

export const directChatLookup = {
	key(userA: string, userB: string): string {
		const sorted = [userA, userB].sort();
		return `${DIRECT_CHAT_PREFIX}${sorted[0]}:${sorted[1]}`;
	},

	async get(userA: string, userB: string): Promise<string | null> {
		return redis.get(this.key(userA, userB));
	},

	async set(userA: string, userB: string, chatId: string): Promise<void> {
		await redis.set(this.key(userA, userB), chatId);
	},
};

export const otp = {
	async set(phone: string, code: string): Promise<void> {
		await redis.set(`${OTP_PREFIX}${phone}`, code, "EX", Limits.OTP_TTL_SECONDS);
	},

	async get(phone: string): Promise<string | null> {
		return redis.get(`${OTP_PREFIX}${phone}`);
	},

	async del(phone: string): Promise<void> {
		await redis.del(`${OTP_PREFIX}${phone}`);
	},

	async incrementAttempts(phone: string): Promise<number> {
		const key = `${OTP_ATTEMPTS_PREFIX}${phone}`;
		const count = await redis.incr(key);
		if (count === 1) {
			await redis.expire(key, 3600);
		}
		return count;
	},

	async getAttempts(phone: string): Promise<number> {
		const val = await redis.get(`${OTP_ATTEMPTS_PREFIX}${phone}`);
		return val ? Number.parseInt(val, 10) : 0;
	},
};

export const userConnections = {
	async add(userId: string, instanceId: string): Promise<void> {
		const key = `${USER_CONNECTIONS_PREFIX}${userId}`;
		await redis.sadd(key, instanceId);
		await redis.expire(key, 60);
	},

	async remove(userId: string, instanceId: string): Promise<void> {
		await redis.srem(`${USER_CONNECTIONS_PREFIX}${userId}`, instanceId);
	},

	async getInstances(userId: string): Promise<string[]> {
		return redis.smembers(`${USER_CONNECTIONS_PREFIX}${userId}`);
	},

	async isConnected(userId: string): Promise<boolean> {
		const count = await redis.scard(`${USER_CONNECTIONS_PREFIX}${userId}`);
		return count > 0;
	},
};

export const rateLimit = {
	async check(key: string, maxRequests: number, windowSeconds: number): Promise<boolean> {
		const now = Date.now();
		const windowStart = now - windowSeconds * 1000;
		const redisKey = `${RATE_PREFIX}${key}`;

		const pipeline = redis.pipeline();
		pipeline.zremrangebyscore(redisKey, 0, windowStart);
		pipeline.zadd(redisKey, now, `${now}:${Math.random()}`);
		pipeline.zcard(redisKey);
		pipeline.expire(redisKey, windowSeconds);

		const results = await pipeline.exec();
		const count = results?.[2]?.[1] as number;
		return count <= maxRequests;
	},
};
