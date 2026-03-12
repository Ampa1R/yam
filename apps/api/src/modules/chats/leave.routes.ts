import { and, db, eq, schema, sql } from "@yam/db/pg";
import { chatMembersCache, unread } from "@yam/db/redis";
import { scyllaQueries } from "@yam/db/scylla";
import { ChatRole, ChatType } from "@yam/shared";
import { Elysia, t } from "elysia";
import { authMiddleware } from "../../lib/auth-middleware";

export const leaveRoutes = new Elysia()
	.use(authMiddleware)
	.delete(
		"/:id/leave",
		async ({ params, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const [chat] = await db
				.select({ type: schema.chats.type })
				.from(schema.chats)
				.where(eq(schema.chats.id, params.id))
				.limit(1);
			if (!chat || chat.type !== ChatType.GROUP) {
				set.status = 400;
				return { error: "Leave operation is available only for group chats" };
			}

			const [myMembership] = await db
				.select({ role: schema.chatMembers.role })
				.from(schema.chatMembers)
				.where(
					and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)),
				)
				.limit(1);
			if (!myMembership) {
				set.status = 404;
				return { error: "You are not a member of this chat" };
			}
			if (myMembership.role === ChatRole.OWNER) {
				set.status = 400;
				return { error: "Owner cannot leave the group. Transfer ownership first." };
			}

			let leftRows: { userId: string }[] = [];
			await db.transaction(async (tx) => {
				leftRows = await tx
					.delete(schema.chatMembers)
					.where(
						and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)),
					)
					.returning({ userId: schema.chatMembers.userId });

				if (leftRows.length > 0) {
					await tx
						.update(schema.chats)
						.set({ memberCount: sql`${schema.chats.memberCount} - 1`, updatedAt: new Date() })
						.where(eq(schema.chats.id, params.id));
				}
			});

			if (leftRows.length === 0) {
				set.status = 404;
				return { error: "You are not a member of this chat" };
			}

			await chatMembersCache.invalidate(params.id);
			await scyllaQueries.deleteInboxEntry(userId, params.id);
			await unread.reset(userId, params.id);

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
		},
	);
