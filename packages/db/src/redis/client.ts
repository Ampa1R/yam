import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

export const redis = new Redis(redisUrl, {
	maxRetriesPerRequest: 3,
	retryStrategy(times) {
		return Math.min(times * 200, 5000);
	},
	lazyConnect: true,
});

redis.on("error", (err) => {
	console.error("[Redis] Connection error:", err.message);
});

redis.on("reconnecting", (ms: number) => {
	console.log(`[Redis] Reconnecting in ${ms}ms...`);
});

export function createRedisSubscriber(): Redis {
	const sub = new Redis(redisUrl, {
		maxRetriesPerRequest: null,
		lazyConnect: true,
	});
	sub.on("error", (err) => {
		console.error("[Redis:Sub] Connection error:", err.message);
	});
	return sub;
}

export async function connectRedis(): Promise<void> {
	await redis.connect();
	console.log("[Redis] Connected");
}

export async function disconnectRedis(): Promise<void> {
	await redis.quit();
	console.log("[Redis] Disconnected");
}
