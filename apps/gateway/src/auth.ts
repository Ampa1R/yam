import { randomUUID } from "node:crypto";
import { db, eq, schema } from "@yam/db/pg";
import { presence, publishToUsers, userConnections } from "@yam/db/redis";
import type { ServerEvent } from "@yam/shared";
import { verifyAccessToken } from "@yam/shared/jwt";
import { connectionManager, type WsData } from "./connection/manager";
import { getPresenceSubscribers } from "./lib/chat-members";
import { sendWsError, withEventId } from "./ws-errors";

export interface AuthWsData extends Partial<WsData> {
	isAuthenticated?: boolean;
	authTimeout?: ReturnType<typeof setTimeout>;
	lastPresenceRefresh?: number;
}

export async function authenticateConnection(
	ws: any,
	token: string,
	instanceId: string,
	pubsub: { subscribe: (userId: string) => Promise<void> },
): Promise<boolean> {
	const payload = await verifyAccessToken(token);
	if (!payload) {
		sendWsError(ws, "AUTH_FAILED", "Invalid token");
		ws.close();
		return false;
	}

	const [user] = await db
		.select({ role: schema.users.role })
		.from(schema.users)
		.where(eq(schema.users.id, payload.sub))
		.limit(1);
	if (!user) {
		sendWsError(ws, "AUTH_FAILED", "User not found");
		ws.close();
		return false;
	}

	if (user.role < 0) {
		sendWsError(ws, "ACCOUNT_SUSPENDED", "Account suspended");
		ws.close();
		return false;
	}

	const wsData = ws.data as unknown as AuthWsData;
	if (wsData.authTimeout) {
		clearTimeout(wsData.authTimeout);
		wsData.authTimeout = undefined;
	}

	const userId = payload.sub;
	const connId = randomUUID();
	wsData.userId = userId;
	wsData.connId = connId;
	wsData.isAuthenticated = true;

	connectionManager.add(userId, connId, ws);

	await pubsub.subscribe(userId);
	await presence.setOnline(userId);
	await userConnections.add(userId, instanceId);

	ws.send(
		JSON.stringify(
			withEventId({
				event: "auth:ok",
				data: { userId },
			}),
		),
	);

	console.log(
		`[GW] ${userId} connected (conn: ${connId}, total: ${connectionManager.getConnectionCount()})`,
	);

	getPresenceSubscribers(userId)
		.then((peerIds) => {
			if (peerIds.length === 0) return;
			const event: ServerEvent = withEventId({
				event: "presence",
				data: { userId, status: "online", lastSeen: null },
			});
			const local = peerIds.filter((id) => connectionManager.isLocal(id));
			const remote = peerIds.filter((id) => !connectionManager.isLocal(id));
			connectionManager.sendToUsers(local, event);
			if (remote.length > 0) publishToUsers(remote, event);
		})
		.catch((err) => console.error("[GW] Failed to broadcast online presence:", err));

	return true;
}
