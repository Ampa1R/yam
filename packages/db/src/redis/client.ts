import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

export const redis = new Redis(redisUrl, {
	maxRetriesPerRequest: 3,
	retryStrategy(times) {
		return Math.min(times * 200, 5000);
	},
	lazyConnect: true,
});

export function createRedisSubscriber(): Redis {
	return new Redis(redisUrl, {
		maxRetriesPerRequest: null,
		lazyConnect: true,
	});
}

export async function connectRedis(): Promise<void> {
	await redis.connect();
	console.log("[Redis] Connected");
}

export async function disconnectRedis(): Promise<void> {
	await redis.quit();
	console.log("[Redis] Disconnected");
}
