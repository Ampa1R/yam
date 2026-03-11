import { db, eq, sql, schema } from "@yam/db/pg";
export { getChatMemberIds } from "@yam/db/redis";

export async function getContactUserIds(userId: string): Promise<string[]> {
	const contacts = await db
		.select({ contactId: schema.contacts.contactId })
		.from(schema.contacts)
		.where(eq(schema.contacts.userId, userId));

	const reverseContacts = await db
		.select({ userId: schema.contacts.userId })
		.from(schema.contacts)
		.where(eq(schema.contacts.contactId, userId));

	const ids = new Set<string>();
	for (const c of contacts) ids.add(c.contactId);
	for (const c of reverseContacts) ids.add(c.userId);
	return Array.from(ids);
}

export async function getPresenceSubscribers(userId: string): Promise<string[]> {
	const rows = await db.execute<{ user_id: string }>(sql`
		SELECT DISTINCT cm2.user_id::text AS user_id
		FROM chat_members cm1
		INNER JOIN chat_members cm2
			ON cm1.chat_id = cm2.chat_id
		WHERE cm1.user_id = ${userId}
			AND cm2.user_id != ${userId}
		LIMIT 500
	`);
	return rows.map((r) => r.user_id);
}
