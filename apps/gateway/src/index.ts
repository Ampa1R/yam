import { randomUUID } from "node:crypto";
import { connectRedis, createPubSubManager, presence, userConnections } from "@yam/db/redis";
import { connectScylla } from "@yam/db/scylla";
import type { ClientEvent } from "@yam/shared";
import { Elysia } from "elysia";
import { connectionManager, type WsData } from "./connection/manager";
import { handleDeleteMessage, handleEditMessage, handleSendMessage } from "./handlers/message";
import { handleReadMessage } from "./handlers/read";
import { handleTypingStart, handleTypingStop } from "./handlers/typing";
import { verifyAccessToken } from "@yam/shared/jwt";

const port = Number(process.env.GATEWAY_PORT ?? 3001);
const INSTANCE_ID = `gw-${randomUUID().slice(0, 8)}`;

await connectRedis();
await connectScylla();

const pubsub = createPubSubManager();
pubsub.onMessage((userId, event) => {
	connectionManager.sendToUser(userId, event);
});

const _app = new Elysia()
	.get("/health", () => ({
		status: "ok",
		service: "gateway",
		instance: INSTANCE_ID,
		connections: connectionManager.getConnectionCount(),
		timestamp: new Date().toISOString(),
	}))
	.ws("/ws", {
		async open(ws) {
			const url = new URL(ws.data.request.url);
			const token = url.searchParams.get("token");

			if (!token) {
				ws.send(
					JSON.stringify({
						event: "error",
						data: { code: "AUTH_REQUIRED", message: "Token required" },
					}),
				);
				ws.close();
				return;
			}

			const payload = await verifyAccessToken(token);
			if (!payload) {
				ws.send(
					JSON.stringify({
						event: "error",
						data: { code: "AUTH_FAILED", message: "Invalid token" },
					}),
				);
				ws.close();
				return;
			}

			const userId = payload.sub;
			const connId = randomUUID();
			(ws.data as WsData).userId = userId;
			(ws.data as WsData).connId = connId;

			connectionManager.add(userId, connId, ws as any);

			await pubsub.subscribe(userId);
			await presence.setOnline(userId);
			await userConnections.add(userId, INSTANCE_ID);

			console.log(
				`[GW] ${userId} connected (conn: ${connId}, total: ${connectionManager.getConnectionCount()})`,
			);
		},

		async message(ws, rawMessage) {
			const { userId } = ws.data as WsData;
			if (!userId) return;

			await presence.setOnline(userId);

			let event: ClientEvent;
			try {
				event =
					typeof rawMessage === "string"
						? JSON.parse(rawMessage)
						: JSON.parse(new TextDecoder().decode(rawMessage as ArrayBuffer));
			} catch {
				ws.send(
					JSON.stringify({
						event: "error",
						data: { code: "PARSE_ERROR", message: "Invalid JSON" },
					}),
				);
				return;
			}

			try {
				switch (event.event) {
					case "ping":
						ws.send(JSON.stringify({ event: "pong" }));
						break;
					case "message:send":
						await handleSendMessage(userId, event.data);
						break;
					case "message:edit":
						await handleEditMessage(userId, event.data);
						break;
					case "message:delete":
						await handleDeleteMessage(userId, event.data);
						break;
					case "message:read":
						await handleReadMessage(userId, event.data);
						break;
					case "typing:start":
						await handleTypingStart(userId, event.data);
						break;
					case "typing:stop":
						await handleTypingStop(userId, event.data);
						break;
					default:
						ws.send(
							JSON.stringify({
								event: "error",
								data: { code: "UNKNOWN_EVENT", message: "Unknown event" },
							}),
						);
				}
			} catch (err) {
				console.error(`[GW] Error handling ${event.event}:`, err);
				ws.send(
					JSON.stringify({
						event: "error",
						data: { code: "INTERNAL_ERROR", message: "Failed to process event" },
					}),
				);
			}
		},

		async close(ws) {
			const { userId, connId } = ws.data as WsData;
			if (!userId) return;

			connectionManager.remove(userId, connId);

			if (!connectionManager.isLocal(userId)) {
				await pubsub.unsubscribe(userId);
				await presence.setOffline(userId);
				await userConnections.remove(userId, INSTANCE_ID);
			}

			console.log(`[GW] ${userId} disconnected (total: ${connectionManager.getConnectionCount()})`);
		},
	})
	.listen(port);

console.log(`[Gateway] ${INSTANCE_ID} running on ws://localhost:${port}`);
