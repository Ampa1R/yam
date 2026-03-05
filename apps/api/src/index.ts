import { cors } from "@elysiajs/cors";
import { connectRedis, disconnectRedis } from "@yam/db/redis";
import { connectScylla, disconnectScylla } from "@yam/db/scylla";
import { Elysia } from "elysia";
import { authRoutes } from "./modules/auth/routes";
import { chatsRoutes } from "./modules/chats/routes";
import { contactsRoutes } from "./modules/contacts/routes";
import { filesRoutes } from "./modules/files/routes";
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
	.get("/health", () => ({ status: "ok", service: "api", timestamp: new Date().toISOString() }))
	.group("/api", (app) =>
		app
			.use(authRoutes)
			.use(usersRoutes)
			.use(contactsRoutes)
			.use(chatsRoutes)
			.use(messagesRoutes)
			.use(filesRoutes),
	)
	.listen(port);

console.log(`[API] Running on http://localhost:${port}`);

async function gracefulShutdown(signal: string) {
	console.log(`[API] ${signal} received, shutting down gracefully...`);
	app.stop();
	await disconnectRedis();
	await disconnectScylla();
	console.log(`[API] Shutdown complete`);
	process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export type App = typeof app;
