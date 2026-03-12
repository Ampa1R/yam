import { createHash } from "node:crypto";
import { db, sql } from "@yam/db/pg";
import { ChatType } from "@yam/shared";

export function directPairKey(userA: string, userB: string): string {
	return [userA, userB].sort().join(":");
}

export function deterministicDirectChatId(userA: string, userB: string): string {
	const hex = createHash("md5").update(`direct:${directPairKey(userA, userB)}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function findExistingDirectChatId(userA: string, userB: string): Promise<string | null> {
	const rows = await db.execute<{ id: string }>(sql`
		SELECT c.id
		FROM chats c
		INNER JOIN chat_members cm ON cm.chat_id = c.id
		WHERE c.type = ${ChatType.DIRECT}
			AND cm.user_id::text IN (${userA}, ${userB})
		GROUP BY c.id
		HAVING COUNT(DISTINCT cm.user_id) = 2
		LIMIT 1
	`);
	return rows[0]?.id ?? null;
}
