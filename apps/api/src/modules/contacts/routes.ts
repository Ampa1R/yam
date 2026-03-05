import { and, db, eq, schema } from "@yam/db/pg";
import { presence } from "@yam/db/redis";
import { Elysia, t } from "elysia";
import { authMiddleware } from "../../lib/auth-middleware";

export const contactsRoutes = new Elysia({ prefix: "/contacts" })
	.use(authMiddleware)
	.get(
		"/",
		async ({ userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const rows = await db
				.select({
					userId: schema.contacts.userId,
					contactId: schema.contacts.contactId,
					nickname: schema.contacts.nickname,
					createdAt: schema.contacts.createdAt,
					contactDisplayName: schema.users.displayName,
					contactUsername: schema.users.username,
					contactAvatarUrl: schema.users.avatarUrl,
					contactStatusText: schema.users.statusText,
				})
				.from(schema.contacts)
				.innerJoin(schema.users, eq(schema.contacts.contactId, schema.users.id))
				.where(eq(schema.contacts.userId, userId))
				.orderBy(schema.users.displayName);

			const contactIds = rows.map((r) => r.contactId);
			const presenceMap = await presence.getMultiplePresence(contactIds);

			return {
				contacts: rows.map((r) => {
					const p = presenceMap.get(r.contactId);
					return {
						userId: r.userId,
						contactId: r.contactId,
						nickname: r.nickname,
						createdAt: r.createdAt.toISOString(),
						user: {
							id: r.contactId,
							displayName: r.contactDisplayName,
							username: r.contactUsername,
							avatarUrl: r.contactAvatarUrl,
							statusText: r.contactStatusText,
							isOnline: p?.online ?? false,
							lastSeen: p?.lastSeen ?? null,
						},
					};
				}),
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

			if (body.userId === userId) {
				set.status = 400;
				return { error: "Cannot add yourself as a contact" };
			}

			const [targetUser] = await db
				.select()
				.from(schema.users)
				.where(eq(schema.users.id, body.userId))
				.limit(1);

			if (!targetUser) {
				set.status = 404;
				return { error: "User not found" };
			}

			await db
				.insert(schema.contacts)
				.values({ userId, contactId: body.userId })
				.onConflictDoNothing({ target: [schema.contacts.userId, schema.contacts.contactId] });

			return {
				contact: {
					userId,
					contactId: body.userId,
					nickname: null,
					user: {
						id: targetUser.id,
						displayName: targetUser.displayName,
						username: targetUser.username,
						avatarUrl: targetUser.avatarUrl,
						statusText: targetUser.statusText,
						isOnline: false,
						lastSeen: null,
					},
				},
			};
		},
		{
			requireAuth: true,
			body: t.Object({ userId: t.String() }),
		},
	)
	.delete(
		"/:contactId",
		async ({ params, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			await db
				.delete(schema.contacts)
				.where(
					and(eq(schema.contacts.userId, userId), eq(schema.contacts.contactId, params.contactId)),
				);

			return { success: true };
		},
		{
			requireAuth: true,
			params: t.Object({ contactId: t.String() }),
		},
	);
