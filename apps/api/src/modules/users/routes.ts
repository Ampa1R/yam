import { and, db, eq, ilike, or, schema, sql } from "@yam/db/pg";
import { presence, rateLimit } from "@yam/db/redis";
import { Elysia, t } from "elysia";
import { authMiddleware } from "../../lib/auth-middleware";

export const usersRoutes = new Elysia({ prefix: "/users" })
	.use(authMiddleware)
	.get(
		"/me",
		async ({ userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const [user] = await db
				.select()
				.from(schema.users)
				.where(eq(schema.users.id, userId))
				.limit(1);

			if (!user) {
				set.status = 404;
				return { error: "User not found" };
			}

			return {
				id: user.id,
				phone: user.phone,
				username: user.username,
				displayName: user.displayName,
				avatarUrl: user.avatarUrl,
				statusText: user.statusText,
				isProfilePublic: user.isProfilePublic,
				role: user.role,
				createdAt: user.createdAt.toISOString(),
				updatedAt: user.updatedAt.toISOString(),
			};
		},
		{ requireAuth: true },
	)
	.patch(
		"/me",
		async ({ userId, body, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const updates: Record<string, unknown> = { updatedAt: new Date() };
			if (body.displayName !== undefined) updates.displayName = body.displayName;
			if (body.username !== undefined) updates.username = body.username;
			if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl;
			if (body.statusText !== undefined) updates.statusText = body.statusText;
			if (body.isProfilePublic !== undefined) updates.isProfilePublic = body.isProfilePublic;

			let user;
			try {
				[user] = await db
					.update(schema.users)
					.set(updates)
					.where(eq(schema.users.id, userId))
					.returning();
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				if (message.includes("unique") || message.includes("duplicate")) {
					set.status = 409;
					return { error: "Username is already taken" };
				}
				throw err;
			}

			if (!user) {
				set.status = 404;
				return { error: "User not found" };
			}

			return {
				id: user.id,
				phone: user.phone,
				username: user.username,
				displayName: user.displayName,
				avatarUrl: user.avatarUrl,
				statusText: user.statusText,
				isProfilePublic: user.isProfilePublic,
				role: user.role,
				createdAt: user.createdAt.toISOString(),
				updatedAt: user.updatedAt.toISOString(),
			};
		},
		{
			requireAuth: true,
			body: t.Object({
				displayName: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
				username: t.Optional(t.String({ minLength: 3, maxLength: 50, pattern: "^[a-zA-Z0-9_]+$" })),
				avatarUrl: t.Optional(t.Nullable(t.String())),
				statusText: t.Optional(t.Nullable(t.String({ maxLength: 200 }))),
				isProfilePublic: t.Optional(t.Boolean()),
			}),
		},
	)
	.get(
		"/search",
		async ({ query, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const allowed = await rateLimit.check(`${userId}:search`, 30, 60);
			if (!allowed) {
				set.status = 429;
				return { error: "Search rate limit exceeded. Try again later." };
			}

			const { q } = query;
			if (!q || q.length < 2) return { users: [] };

			const escapedQ = q.replace(/[%_\\]/g, "\\$&");

			const results = await db
				.select({
					id: schema.users.id,
					displayName: schema.users.displayName,
					username: schema.users.username,
					avatarUrl: schema.users.avatarUrl,
				})
				.from(schema.users)
				.where(
					and(
						sql`${schema.users.id} != ${userId}`,
						or(
							ilike(schema.users.displayName, `%${escapedQ}%`),
							ilike(schema.users.username, `%${escapedQ}%`),
							eq(schema.users.phone, q),
						),
					),
				)
				.limit(20);

			const userIds = results.map((u) => u.id);
			const presenceMap = await presence.getMultiplePresence(userIds);

			return {
				users: results.map((u) => ({
					id: u.id,
					displayName: u.displayName,
					username: u.username,
					avatarUrl: u.avatarUrl,
					isOnline: presenceMap.get(u.id)?.online ?? false,
				})),
			};
		},
		{
			requireAuth: true,
			query: t.Object({
				q: t.String(),
			}),
		},
	)
	.get(
		"/:id",
		async ({ params, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const [user] = await db
				.select()
				.from(schema.users)
				.where(eq(schema.users.id, params.id))
				.limit(1);

			if (!user) {
				set.status = 404;
				return { error: "User not found" };
			}

			const [isContact] = await db
				.select()
				.from(schema.contacts)
				.where(and(eq(schema.contacts.userId, userId), eq(schema.contacts.contactId, params.id)))
				.limit(1);

			const [isBlocked] = await db
				.select()
				.from(schema.blockedUsers)
				.where(
					and(eq(schema.blockedUsers.userId, params.id), eq(schema.blockedUsers.blockedId, userId)),
				)
				.limit(1);

			if (isBlocked) {
				return {
					id: user.id,
					displayName: user.displayName,
					username: user.username,
					avatarUrl: null,
					statusText: null,
					isOnline: false,
					lastSeen: null,
				};
			}

			const showFull = user.isProfilePublic || !!isContact;
			const presenceData = await presence.getMultiplePresence([user.id]);
			const p = presenceData.get(user.id);

			return {
				id: user.id,
				displayName: user.displayName,
				username: user.username,
				avatarUrl: showFull ? user.avatarUrl : null,
				statusText: showFull ? user.statusText : null,
				isOnline: showFull ? (p?.online ?? false) : false,
				lastSeen: showFull ? (p?.lastSeen ?? null) : null,
			};
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
		},
	)
	.post(
		"/:id/block",
		async ({ params, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			if (params.id === userId) {
				set.status = 400;
				return { error: "Cannot block yourself" };
			}

			await db
				.insert(schema.blockedUsers)
				.values({ userId, blockedId: params.id })
				.onConflictDoNothing({
					target: [schema.blockedUsers.userId, schema.blockedUsers.blockedId],
				});

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
		},
	)
	.delete(
		"/:id/block",
		async ({ params, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			await db
				.delete(schema.blockedUsers)
				.where(
					and(eq(schema.blockedUsers.userId, userId), eq(schema.blockedUsers.blockedId, params.id)),
				);

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
		},
	);
