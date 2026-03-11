import { cors } from "@elysiajs/cors";
import { db, desc, eq, ilike, schema, sql } from "@yam/db/pg";
import { connectRedis, disconnectRedis, publishBan, redis } from "@yam/db/redis";
import { connectScylla, disconnectScylla } from "@yam/db/scylla";
import { UserRole } from "@yam/shared";
import { verifyAccessToken } from "@yam/shared/jwt";
import { Elysia, t } from "elysia";

const port = Number(process.env.ADMIN_PORT ?? 3002);
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS?.split(",").filter(Boolean) ?? [];

await connectRedis();
await connectScylla();

async function extractAdminUserId(header: string | null): Promise<string | null> {
	if (!header?.startsWith("Bearer ")) return null;
	const token = header.slice(7);
	const payload = await verifyAccessToken(token);
	if (!payload) return null;
	if (payload.role < UserRole.ADMIN) return null;
	return payload.sub;
}

const app = new Elysia()
	.use(
		cors(
			ALLOWED_ORIGINS.length > 0
				? { origin: ALLOWED_ORIGINS, credentials: true }
				: undefined,
		),
	)
	.derive(async ({ request }) => {
		const adminUserId = await extractAdminUserId(request.headers.get("authorization"));
		return { adminUserId };
	})
	.onBeforeHandle(({ adminUserId, set, path }) => {
		if (path === "/health") return;
		if (!adminUserId) {
			set.status = 401;
			return { error: "Admin access required" };
		}
	})
	.get("/health", () => ({
		status: "ok",
		service: "admin",
		timestamp: new Date().toISOString(),
	}))
	.group("/admin", (app) =>
		app
			.get(
				"/users",
				async ({ query }) => {
					const page = Number(query.page) || 1;
					const limit = Math.min(Number(query.limit) || 50, 100);
					const offset = (page - 1) * limit;

					const escapedQ = query.q?.replace(/[%_\\]/g, "\\$&");
					const filter = escapedQ ? ilike(schema.users.displayName, `%${escapedQ}%`) : undefined;

					const users = await db
						.select()
						.from(schema.users)
						.where(filter)
						.orderBy(desc(schema.users.createdAt))
						.limit(limit)
						.offset(offset);

					const [countRow] = await db
						.select({ value: sql<string>`count(*)` })
						.from(schema.users)
						.where(filter);

					return {
						users,
						total: Number(countRow?.value ?? 0),
						page,
						limit,
					};
				},
				{
					query: t.Object({
						q: t.Optional(t.String()),
						page: t.Optional(t.String()),
						limit: t.Optional(t.String()),
					}),
				},
			)
			.patch(
				"/users/:id/ban",
				async ({ params }) => {
					await db
						.update(schema.users)
						.set({ role: -1 as number, updatedAt: new Date() })
						.where(eq(schema.users.id, params.id));

					await db.delete(schema.refreshTokens).where(eq(schema.refreshTokens.userId, params.id));
					await publishBan(params.id);

					return { success: true, message: `User ${params.id} banned` };
				},
				{ params: t.Object({ id: t.String() }) },
			)
			.patch(
				"/users/:id/unban",
				async ({ params }) => {
					await db
						.update(schema.users)
						.set({ role: UserRole.USER, updatedAt: new Date() })
						.where(eq(schema.users.id, params.id));

					return { success: true, message: `User ${params.id} unbanned` };
				},
				{ params: t.Object({ id: t.String() }) },
			)
			.get("/stats", async () => {
				const [userRow] = await db.select({ value: sql<string>`count(*)` }).from(schema.users);
				const [chatRow] = await db.select({ value: sql<string>`count(*)` }).from(schema.chats);

				const redisInfo = await redis.info("clients");
				const connectedClients = redisInfo.match(/connected_clients:(\d+)/)?.[1] ?? "unknown";

				return {
					users: Number(userRow?.value ?? 0),
					chats: Number(chatRow?.value ?? 0),
					redisConnectedClients: connectedClients,
					timestamp: new Date().toISOString(),
				};
			})
			.get("/settings", async () => {
				const settings = await db.select().from(schema.systemSettings);
				return {
					settings: Object.fromEntries(settings.map((s) => [s.key, s.value])),
				};
			})
			.put(
				"/settings/:key",
				async ({ params, body, adminUserId }) => {
					await db
						.insert(schema.systemSettings)
						.values({
							key: params.key,
							value: body.value,
							updatedAt: new Date(),
							updatedBy: adminUserId,
						})
						.onConflictDoUpdate({
							target: schema.systemSettings.key,
							set: {
								value: body.value,
								updatedAt: new Date(),
								updatedBy: adminUserId,
							},
						});

					return { success: true };
				},
				{
					params: t.Object({ key: t.String() }),
					body: t.Object({ value: t.Any() }),
				},
			),
	)
	.listen(port);

console.log(`[Admin] Running on http://localhost:${port}`);

let shuttingDown = false;
async function gracefulShutdown(signal: string) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[Admin] ${signal} received, shutting down gracefully...`);
	try { app.stop(); } catch {}
	await disconnectRedis().catch(() => {});
	await disconnectScylla().catch(() => {});
	console.log(`[Admin] Shutdown complete`);
	process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
