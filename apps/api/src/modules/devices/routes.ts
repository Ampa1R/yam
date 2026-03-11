import { and, db, eq, schema } from "@yam/db/pg";
import { Platform } from "@yam/shared";
import { Elysia, t } from "elysia";
import { authMiddleware } from "../../lib/auth-middleware";

export const devicesRoutes = new Elysia({ prefix: "/devices" })
	.use(authMiddleware)
	.get(
		"/",
		async ({ userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const devices = await db
				.select({
					id: schema.deviceTokens.id,
					platform: schema.deviceTokens.platform,
					token: schema.deviceTokens.token,
					createdAt: schema.deviceTokens.createdAt,
				})
				.from(schema.deviceTokens)
				.where(eq(schema.deviceTokens.userId, userId));

			return {
				devices: devices.map((d) => ({
					...d,
					createdAt: d.createdAt.toISOString(),
				})),
			};
		},
		{ requireAuth: true },
	)
	.post(
		"/",
		async ({ body, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const [device] = await db
				.insert(schema.deviceTokens)
				.values({
					userId,
					platform: body.platform,
					token: body.token,
				})
				.onConflictDoUpdate({
					target: [schema.deviceTokens.token],
					set: {
						userId,
						platform: body.platform,
					},
				})
				.returning({
					id: schema.deviceTokens.id,
					platform: schema.deviceTokens.platform,
					token: schema.deviceTokens.token,
				});

			return { device };
		},
		{
			requireAuth: true,
			body: t.Object({
				platform: t.Number({ minimum: Platform.WEB, maximum: Platform.ANDROID }),
				token: t.String({ minLength: 10, maxLength: 4096 }),
			}),
		},
	)
	.delete(
		"/:id",
		async ({ params, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const deleted = await db
				.delete(schema.deviceTokens)
				.where(and(eq(schema.deviceTokens.id, params.id), eq(schema.deviceTokens.userId, userId)))
				.returning({ id: schema.deviceTokens.id });
			if (deleted.length === 0) {
				set.status = 404;
				return { error: "Device token not found" };
			}

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
		},
	);
