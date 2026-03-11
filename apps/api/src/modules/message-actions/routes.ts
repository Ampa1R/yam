import { randomUUID } from "node:crypto";
import { and, db, eq, schema } from "@yam/db/pg";
import { getChatMemberIds, publishToUsers } from "@yam/db/redis";
import { scyllaQueries } from "@yam/db/scylla";
import { ChatRole, Limits, type ServerEvent } from "@yam/shared";
import { Elysia, t } from "elysia";
import { authMiddleware } from "../../lib/auth-middleware";

export const messageActionsRoutes = new Elysia({ prefix: "/messages" })
	.use(authMiddleware)
	.patch(
		"/:id",
		async ({ params, body, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}
			if (body.content.length > Limits.MAX_MESSAGE_LENGTH) {
				set.status = 400;
				return { error: `Message exceeds ${Limits.MAX_MESSAGE_LENGTH} characters` };
			}

			const memberIds = await getChatMemberIds(body.chatId);
			if (!memberIds.includes(userId)) {
				set.status = 403;
				return { error: "Not a member of this chat" };
			}

			const bucket = scyllaQueries.bucketFromTimeuuid(params.id);
			const existing = await scyllaQueries.getMessage(body.chatId, params.id, bucket);
			if (!existing) {
				set.status = 404;
				return { error: "Message not found" };
			}
			if (existing.senderId !== userId) {
				set.status = 403;
				return { error: "You can only edit your own messages" };
			}
			if (existing.isDeleted) {
				set.status = 410;
				return { error: "Message has been deleted" };
			}

			await scyllaQueries.editMessage(body.chatId, params.id, bucket, body.content);
			const editedAt = new Date().toISOString();

			const event: ServerEvent = {
				event: "message:updated",
				data: {
					messageId: params.id,
					chatId: body.chatId,
					content: body.content,
					editedAt,
				},
				eventId: randomUUID(),
			};
			await publishToUsers(memberIds.filter((id) => id !== userId), event);

			return { success: true, editedAt };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
			body: t.Object({
				chatId: t.String(),
				content: t.String({ maxLength: Limits.MAX_MESSAGE_LENGTH }),
			}),
		},
	)
	.delete(
		"/:id",
		async ({ params, query, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			if (!query.chatId) {
				set.status = 400;
				return { error: "chatId query parameter is required" };
			}

			const chatId = query.chatId;
			const memberIds = await getChatMemberIds(chatId);
			if (!memberIds.includes(userId)) {
				set.status = 403;
				return { error: "Not a member of this chat" };
			}

			const bucket = scyllaQueries.bucketFromTimeuuid(params.id);
			const existing = await scyllaQueries.getMessage(chatId, params.id, bucket);
			if (!existing) {
				set.status = 404;
				return { error: "Message not found" };
			}

			if (existing.senderId !== userId) {
				const [membership] = await db
					.select({ role: schema.chatMembers.role })
					.from(schema.chatMembers)
					.where(
						and(
							eq(schema.chatMembers.chatId, chatId),
							eq(schema.chatMembers.userId, userId),
						),
					)
					.limit(1);
				if (!membership || membership.role < ChatRole.ADMIN) {
					set.status = 403;
					return { error: "You can only delete your own messages" };
				}
			}

			await scyllaQueries.softDeleteMessage(chatId, params.id, bucket);

			const event: ServerEvent = {
				event: "message:deleted",
				data: {
					messageId: params.id,
					chatId,
				},
				eventId: randomUUID(),
			};
			await publishToUsers(memberIds.filter((id) => id !== userId), event);

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
			query: t.Object({ chatId: t.String() }),
		},
	);
