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
