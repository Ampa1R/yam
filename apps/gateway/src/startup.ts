import { presence, redis } from "@yam/db/redis";

export async function cleanupStaleConnections(instanceId: string): Promise<void> {
	let cursor = "0";
	let cleaned = 0;
	do {
		const [nextCursor, keys] = await redis.scan(Number(cursor), "MATCH", "user:connections:*", "COUNT", 200);
		cursor = String(nextCursor);
		if (keys.length === 0) continue;

		const pipeline = redis.pipeline();
		for (const key of keys) {
			pipeline.srem(key, instanceId);
		}
		await pipeline.exec();

		for (const key of keys) {
			const remaining = await redis.scard(key);
			if (remaining === 0) {
				const userId = key.replace("user:connections:", "");
				await presence.setOffline(userId);
			}
		}
		cleaned += keys.length;
	} while (cursor !== "0");

	if (cleaned > 0) {
		console.log(`[Gateway] Cleaned up stale connections for ${instanceId} from ${cleaned} keys`);
	}
}
