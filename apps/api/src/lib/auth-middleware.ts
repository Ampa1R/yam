import { Elysia } from "elysia";
import { db, eq, schema } from "@yam/db/pg";
import { subscribeToBans } from "@yam/db/redis";
import { verifyAccessToken } from "@yam/shared/jwt";

const BANNED_CACHE_TTL_MS = 60_000;
const bannedUserCache = new Map<string, { banned: boolean; expiresAt: number }>();

subscribeToBans((userId) => {
	bannedUserCache.set(userId, { banned: true, expiresAt: Date.now() + BANNED_CACHE_TTL_MS });
});

async function isUserBanned(userId: string): Promise<boolean> {
	const cached = bannedUserCache.get(userId);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.banned;
	}

	const [user] = await db
		.select({ role: schema.users.role })
		.from(schema.users)
		.where(eq(schema.users.id, userId))
		.limit(1);

	const banned = !user || user.role < 0;
	bannedUserCache.set(userId, { banned, expiresAt: Date.now() + BANNED_CACHE_TTL_MS });

	if (bannedUserCache.size > 10_000) {
		const now = Date.now();
		for (const [key, entry] of bannedUserCache) {
			if (entry.expiresAt < now) bannedUserCache.delete(key);
		}
	}

	return banned;
}

export const authMiddleware = new Elysia({ name: "auth" })
	.derive(async ({ request }) => {
		const header = request.headers.get("authorization");
		if (!header?.startsWith("Bearer ")) {
			return { userId: null as string | null, userRole: null as number | null };
		}

		const token = header.slice(7);
		const payload = await verifyAccessToken(token);

		if (!payload) {
			return { userId: null as string | null, userRole: null as number | null };
		}

		return { userId: payload.sub, userRole: payload.role };
	})
	.macro({
		requireAuth(enabled: boolean) {
			if (!enabled) return;
			return {
				async beforeHandle({ userId, userRole, set }) {
					if (!userId) {
						set.status = 401;
						return { error: "Unauthorized" };
					}
					if (userRole != null && userRole < 0) {
						set.status = 403;
						return { error: "Account suspended", code: "ACCOUNT_SUSPENDED" };
					}
					const banned = await isUserBanned(userId);
					if (banned) {
						set.status = 403;
						return { error: "Account suspended", code: "ACCOUNT_SUSPENDED" };
					}
				},
			};
		},
	})
	.as("global");
