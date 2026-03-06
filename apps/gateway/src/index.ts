import { randomUUID } from "node:crypto";
import { connectRedis, createPubSubManager, disconnectRedis, presence, publishToUsers, userConnections } from "@yam/db/redis";
import { connectScylla, disconnectScylla } from "@yam/db/scylla";
import type { ClientEvent, ServerEvent } from "@yam/shared";
import { Elysia } from "elysia";
import { connectionManager, type WsData } from "./connection/manager";
import { handleDeleteMessage, handleEditMessage, handleSendMessage } from "./handlers/message";
import { handleReadMessage } from "./handlers/read";
import { handleTypingStart, handleTypingStop } from "./handlers/typing";
import { getContactUserIds } from "./lib/chat-members";
import { verifyAccessToken } from "@yam/shared/jwt";

const port = Number(process.env.GATEWAY_PORT ?? 3001);
const INSTANCE_ID = `gw-${randomUUID().slice(0, 8)}`;
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS?.split(",").filter(Boolean) ?? [];
const MAX_WS_PAYLOAD = 64 * 1024; // 64 KB

await connectRedis();
await connectScylla();

const pubsub = createPubSubManager();
pubsub.onMessage((userId, event) => {
	connectionManager.sendToUser(userId, event);
});

const app = new Elysia()
	.get("/health", () => ({
		status: "ok",
		service: "gateway",
		instance: INSTANCE_ID,
		connections: connectionManager.getConnectionCount(),
		timestamp: new Date().toISOString(),
	}))
	.ws("/ws", {
		maxPayloadLength: MAX_WS_PAYLOAD,
		idleTimeout: 60,

		async open(ws) {
			const url = new URL(ws.data.request.url);
			const token = url.searchParams.get("token");

			if (ALLOWED_ORIGINS.length > 0) {
				const origin = ws.data.request.headers.get("origin");
				if (origin && !ALLOWED_ORIGINS.includes(origin)) {
					ws.close(4003, "Origin not allowed");
					return;
				}
			}

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

			if (payload.role < 0) {
				ws.send(
					JSON.stringify({
						event: "error",
						data: { code: "ACCOUNT_SUSPENDED", message: "Account suspended" },
					}),
				);
				ws.close();
				return;
			}

			const userId = payload.sub;
			const connId = randomUUID();
			(ws.data as unknown as WsData).userId = userId;
			(ws.data as unknown as WsData).connId = connId;

			connectionManager.add(userId, connId, ws as any);

			await pubsub.subscribe(userId);
			await presence.setOnline(userId);
			await userConnections.add(userId, INSTANCE_ID);

			console.log(
				`[GW] ${userId} connected (conn: ${connId}, total: ${connectionManager.getConnectionCount()})`,
			);

			getContactUserIds(userId)
				.then((contactIds) => {
					if (contactIds.length === 0) return;
					const event: ServerEvent = {
						event: "presence",
						data: { userId, status: "online", lastSeen: null },
					};
					const local = contactIds.filter((id) => connectionManager.isLocal(id));
					const remote = contactIds.filter((id) => !connectionManager.isLocal(id));
					connectionManager.sendToUsers(local, event);
					if (remote.length > 0) publishToUsers(remote, event);
				})
				.catch(() => {});
		},

		async message(ws, rawMessage) {
			const { userId } = ws.data as unknown as WsData;
			if (!userId) return;

			await presence.setOnline(userId);
			await userConnections.refresh(userId);

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

			if (!event || typeof event !== "object" || typeof event.event !== "string") {
				ws.send(
					JSON.stringify({
						event: "error",
						data: { code: "INVALID_FORMAT", message: "Event must have an 'event' field" },
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
			const { userId, connId } = ws.data as unknown as WsData;
			if (!userId) return;

			connectionManager.remove(userId, connId);

			if (!connectionManager.isLocal(userId)) {
				await pubsub.unsubscribe(userId);
				await presence.setOffline(userId);
				await userConnections.remove(userId, INSTANCE_ID);

				const lastSeen = new Date().toISOString();
				getContactUserIds(userId)
					.then((contactIds) => {
						if (contactIds.length === 0) return;
						const event: ServerEvent = {
							event: "presence",
							data: { userId, status: "offline", lastSeen },
						};
						const local = contactIds.filter((id) => connectionManager.isLocal(id));
						const remote = contactIds.filter((id) => !connectionManager.isLocal(id));
						connectionManager.sendToUsers(local, event);
						if (remote.length > 0) publishToUsers(remote, event);
					})
					.catch(() => {});
			}

			console.log(`[GW] ${userId} disconnected (total: ${connectionManager.getConnectionCount()})`);
		},
	})
	.listen(port);

console.log(`[Gateway] ${INSTANCE_ID} running on ws://localhost:${port}`);

async function gracefulShutdown(signal: string) {
	console.log(`[Gateway] ${signal} received, shutting down gracefully...`);

	for (const userId of connectionManager.getOnlineUserIds()) {
		const conns = connectionManager.getConnections(userId);
		for (const ws of conns) {
			try {
				ws.close(1001, "Server shutting down");
			} catch {}
		}
	}

	await pubsub.shutdown();
	await disconnectRedis();
	await disconnectScylla();
	app.stop();
	console.log(`[Gateway] Shutdown complete`);
	process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
