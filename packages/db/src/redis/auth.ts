import { Limits } from "@yam/shared";
import { redis } from "./client";

const OTP_PREFIX = "otp:";
const OTP_ATTEMPTS_PREFIX = "otp_attempts:";
const RATE_PREFIX = "rate:";

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

	async resetAttempts(phone: string): Promise<void> {
		await redis.del(`${OTP_ATTEMPTS_PREFIX}${phone}`);
	},
};

const BAN_CHANNEL = "user:banned";

export async function publishBan(userId: string): Promise<void> {
	await redis.publish(BAN_CHANNEL, userId);
}

export function subscribeToBans(onBan: (userId: string) => void): void {
	const subscriber = redis.duplicate();
	subscriber.subscribe(BAN_CHANNEL).catch(() => {});
	subscriber.on("message", (_channel: string, userId: string) => {
		onBan(userId);
	});
}

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

	async reset(key: string): Promise<void> {
		await redis.del(`${RATE_PREFIX}${key}`);
	},
};
