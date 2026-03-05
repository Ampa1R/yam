import { db, lt, schema } from "@yam/db/pg";
import { redis } from "@yam/db/redis";

const LOCK_TTL = 300;

async function acquireLock(name: string): Promise<boolean> {
	const result = await redis.set(`lock:${name}`, process.pid.toString(), "EX", LOCK_TTL, "NX");
	return result === "OK";
}

export async function cleanupExpiredTokens(): Promise<void> {
	if (!(await acquireLock("cleanup-tokens"))) return;

	const _result = await db
		.delete(schema.refreshTokens)
		.where(lt(schema.refreshTokens.expiresAt, new Date()));

	console.log("[Cron] Cleaned up expired refresh tokens");
}

export async function syncLastSeen(): Promise<void> {
	if (!(await acquireLock("sync-last-seen"))) return;
	console.log("[Cron] Last seen sync (stub — Redis is source of truth)");
}

export async function cleanupOrphanFiles(): Promise<void> {
	if (!(await acquireLock("cleanup-orphan-files"))) return;

	const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
	console.log(`[Cron] Orphan file cleanup for files before ${cutoff.toISOString()} (stub)`);
}

export function startCronJobs(): void {
	setInterval(cleanupExpiredTokens, 60 * 60 * 1000);
	setInterval(syncLastSeen, 5 * 60 * 1000);
	setInterval(cleanupOrphanFiles, 24 * 60 * 60 * 1000);

	console.log("[Cron] Scheduled jobs started");
}
