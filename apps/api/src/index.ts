import { cors } from "@elysiajs/cors";
import { connectRedis } from "@yam/db/redis";
import { connectScylla } from "@yam/db/scylla";
import { Elysia } from "elysia";
import { authRoutes } from "./modules/auth/routes";
import { chatsRoutes } from "./modules/chats/routes";
import { contactsRoutes } from "./modules/contacts/routes";
import { filesRoutes } from "./modules/files/routes";
import { messagesRoutes } from "./modules/messages/routes";
import { usersRoutes } from "./modules/users/routes";

const port = Number(process.env.API_PORT ?? 3000);

await connectRedis();
await connectScylla();

const app = new Elysia()
	.use(cors())
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

export type App = typeof app;
