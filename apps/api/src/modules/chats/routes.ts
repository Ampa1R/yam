import { Elysia } from "elysia";
import { authMiddleware } from "../../lib/auth-middleware";
import { crudRoutes } from "./crud.routes";
import { inboxRoutes } from "./inbox.routes";
import { leaveRoutes } from "./leave.routes";
import { membersRoutes } from "./members.routes";
import { settingsRoutes } from "./settings.routes";

export const chatsRoutes = new Elysia({ prefix: "/chats" })
	.use(authMiddleware)
	.use(inboxRoutes)
	.use(crudRoutes)
	.use(membersRoutes)
	.use(settingsRoutes)
	.use(leaveRoutes);
