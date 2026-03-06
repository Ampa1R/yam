import { db, eq, schema } from "@yam/db/pg";
import { chatMembersCache } from "@yam/db/redis";

export async function getChatMemberIds(chatId: string): Promise<string[]> {
	const cached = await chatMembersCache.get(chatId);
	if (cached) return cached;

	const members = await db
		.select({ userId: schema.chatMembers.userId })
		.from(schema.chatMembers)
		.where(eq(schema.chatMembers.chatId, chatId));

	const ids = members.map((m) => m.userId);
	await chatMembersCache.set(chatId, ids);
	return ids;
}

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
