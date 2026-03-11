import { cors } from "@elysiajs/cors";
import { connectRedis, disconnectRedis } from "@yam/db/redis";
import { connectScylla, disconnectScylla } from "@yam/db/scylla";
import { Elysia } from "elysia";
import { AppError } from "./lib/errors";
import { authRoutes } from "./modules/auth/routes";
import { chatsRoutes } from "./modules/chats/routes";
import { contactsRoutes } from "./modules/contacts/routes";
import { devicesRoutes } from "./modules/devices/routes";
import { filesRoutes } from "./modules/files/routes";
import { messageActionsRoutes } from "./modules/message-actions/routes";
import { messagesRoutes } from "./modules/messages/routes";
import { usersRoutes } from "./modules/users/routes";

const port = Number(process.env.API_PORT ?? 3000);
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS?.split(",").filter(Boolean) ?? [];

await connectRedis();
await connectScylla();

const app = new Elysia()
	.use(
		cors(
			ALLOWED_ORIGINS.length > 0
				? { origin: ALLOWED_ORIGINS, credentials: true }
				: undefined,
		),
	)
	.onBeforeHandle(({ set }) => {
		set.headers["x-content-type-options"] = "nosniff";
		set.headers["x-frame-options"] = "DENY";
		set.headers["x-xss-protection"] = "0";
		set.headers["referrer-policy"] = "strict-origin-when-cross-origin";
		set.headers["permissions-policy"] = "camera=(), microphone=(self), geolocation=()";
		set.headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
	})
	.onError(({ error, set }) => {
		if (error instanceof AppError) {
			set.status = error.statusCode;
			return { error: error.message, code: error.code };
		}
		console.error("[API] Unhandled error:", error);
		set.status = 500;
		return { error: "Internal server error", code: "INTERNAL_ERROR" };
	})
	.get("/health", async () => {
		const checks: Record<string, string> = {};
		try {
			const { redis } = await import("@yam/db/redis");
			await redis.ping();
			checks.redis = "ok";
		} catch { checks.redis = "error"; }
		try {
			const { db, sql } = await import("@yam/db/pg");
			await db.execute(sql`SELECT 1`);
			checks.postgres = "ok";
		} catch { checks.postgres = "error"; }
		try {
			const { scyllaClient } = await import("@yam/db/scylla");
			await scyllaClient.execute("SELECT now() FROM system.local");
			checks.scylla = "ok";
		} catch { checks.scylla = "error"; }
		const allOk = Object.values(checks).every((v) => v === "ok");
		return {
			status: allOk ? "ok" : "degraded",
			service: "api",
			checks,
			timestamp: new Date().toISOString(),
		};
	})
	.group("/api", (app) =>
		app
			.use(authRoutes)
			.use(usersRoutes)
			.use(contactsRoutes)
			.use(devicesRoutes)
			.use(chatsRoutes)
			.use(messagesRoutes)
			.use(messageActionsRoutes)
			.use(filesRoutes),
	)
	.listen(port);

console.log(`[API] Running on http://localhost:${port}`);

let shuttingDown = false;
async function gracefulShutdown(signal: string) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[API] ${signal} received, shutting down gracefully...`);
	try { app.stop(); } catch {}
	await disconnectRedis().catch(() => {});
	await disconnectScylla().catch(() => {});
	console.log(`[API] Shutdown complete`);
	process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export type App = typeof app;
