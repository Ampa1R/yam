import { Limits } from "@yam/shared";
import { redis } from "./client";

const PRESENCE_PREFIX = "presence:";
const LAST_SEEN_PREFIX = "last_seen:";
const TYPING_PREFIX = "typing:";
const USER_CONNECTIONS_PREFIX = "user:connections:";

export const presence = {
	async setOnline(userId: string): Promise<void> {
		await redis.set(`${PRESENCE_PREFIX}${userId}`, "online", "EX", Limits.PRESENCE_TTL_SECONDS);
	},

	async setOffline(userId: string): Promise<void> {
		await redis.del(`${PRESENCE_PREFIX}${userId}`);
		await redis.set(`${LAST_SEEN_PREFIX}${userId}`, new Date().toISOString(), "EX", 30 * 24 * 3600);
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

const USER_CONN_TTL = 300;

export const userConnections = {
	async add(userId: string, instanceId: string): Promise<void> {
		const key = `${USER_CONNECTIONS_PREFIX}${userId}`;
		const p = redis.pipeline();
		p.sadd(key, instanceId);
		p.expire(key, USER_CONN_TTL);
		await p.exec();
	},

	async refresh(userId: string): Promise<void> {
		await redis.expire(`${USER_CONNECTIONS_PREFIX}${userId}`, USER_CONN_TTL);
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
