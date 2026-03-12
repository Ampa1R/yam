import { and, db, eq, schema } from "@yam/db/pg";
import { Elysia, t } from "elysia";
import { authMiddleware } from "../../lib/auth-middleware";

export const settingsRoutes = new Elysia()
	.use(authMiddleware)
	.patch(
		"/:id/membership",
		async ({ params, body, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			if (body.isPinned === undefined && body.isMuted === undefined) {
				set.status = 400;
				return { error: "At least one field is required: isPinned or isMuted" };
			}

			const updates: { isPinned?: boolean; isMuted?: boolean } = {};
			if (body.isPinned !== undefined) updates.isPinned = body.isPinned;
			if (body.isMuted !== undefined) updates.isMuted = body.isMuted;

			const updated = await db
				.update(schema.chatMembers)
				.set(updates)
				.where(and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)))
				.returning({
					chatId: schema.chatMembers.chatId,
					userId: schema.chatMembers.userId,
					isPinned: schema.chatMembers.isPinned,
					isMuted: schema.chatMembers.isMuted,
				});
			if (updated.length === 0) {
				set.status = 404;
				return { error: "Membership not found" };
			}

			return { membership: updated[0] };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
			body: t.Object({
				isPinned: t.Optional(t.Boolean()),
				isMuted: t.Optional(t.Boolean()),
			}),
		},
	)
	.patch(
		"/:id/pin",
		async ({ params, body, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const updated = await db
				.update(schema.chatMembers)
				.set({ isPinned: body.isPinned })
				.where(
					and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)),
				)
				.returning({ chatId: schema.chatMembers.chatId });

			if (updated.length === 0) {
				set.status = 404;
				return { error: "Chat not found" };
			}

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
			body: t.Object({ isPinned: t.Boolean() }),
		},
	)
	.patch(
		"/:id/mute",
		async ({ params, body, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const updated = await db
				.update(schema.chatMembers)
				.set({ isMuted: body.isMuted })
				.where(
					and(eq(schema.chatMembers.chatId, params.id), eq(schema.chatMembers.userId, userId)),
				)
				.returning({ chatId: schema.chatMembers.chatId });

			if (updated.length === 0) {
				set.status = 404;
				return { error: "Chat not found" };
			}

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
			body: t.Object({ isMuted: t.Boolean() }),
		},
	);
