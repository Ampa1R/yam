import { hostname } from "node:os";
import { connectRedis, createPubSubManager, disconnectRedis, presence, publishToUsers, userConnections } from "@yam/db/redis";
import { connectScylla, disconnectScylla } from "@yam/db/scylla";
import type { ClientEvent, ServerEvent } from "@yam/shared";
import { Elysia } from "elysia";
import { type AuthWsData, authenticateConnection } from "./auth";
import { connectionManager } from "./connection/manager";
import { handleDeleteMessage, handleEditMessage, handleSendMessage } from "./handlers/message";
import { handleReadMessage } from "./handlers/read";
import { handleTypingStart, handleTypingStop } from "./handlers/typing";
import { getPresenceSubscribers } from "./lib/chat-members";
import { cleanupStaleConnections } from "./startup";
import { sendWsError, withEventId } from "./ws-errors";

const port = Number(process.env.GATEWAY_PORT ?? 3001);
const INSTANCE_ID = process.env.GATEWAY_INSTANCE_ID ?? `gw-${hostname()}-${port}`;
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS?.split(",").filter(Boolean) ?? [];
const MAX_WS_PAYLOAD = 64 * 1024;
const WS_AUTH_TIMEOUT_MS = 10_000;
let isShuttingDown = false;

await connectRedis();
await connectScylla();
await cleanupStaleConnections(INSTANCE_ID);

const pubsub = createPubSubManager();
pubsub.onMessage((userId, event) => {
	connectionManager.sendToUser(userId, event);
});

const app = new Elysia()
	.get("/health", async () => {
		const checks: Record<string, string> = {};
		try {
			const { redis } = await import("@yam/db/redis");
			await redis.ping();
			checks.redis = "ok";
		} catch { checks.redis = "error"; }
		const allOk = Object.values(checks).every((v) => v === "ok");
		return {
			status: allOk ? "ok" : "degraded",
			service: "gateway",
			instance: INSTANCE_ID,
			connections: connectionManager.getConnectionCount(),
			checks,
			timestamp: new Date().toISOString(),
		};
	})
	.ws("/ws", {
		maxPayloadLength: MAX_WS_PAYLOAD,
		idleTimeout: 60,

		async open(ws) {
			if (ALLOWED_ORIGINS.length > 0) {
				const origin = ws.data.request.headers.get("origin");
				if (origin && !ALLOWED_ORIGINS.includes(origin)) {
					ws.close(4003, "Origin not allowed");
					return;
				}
			}
			const wsData = ws.data as unknown as AuthWsData;
			wsData.isAuthenticated = false;
			wsData.authTimeout = setTimeout(() => {
				if (!wsData.isAuthenticated) {
					sendWsError(ws, "AUTH_TIMEOUT", "Authentication timed out");
					ws.close();
				}
			}, WS_AUTH_TIMEOUT_MS);
		},

		async message(ws, rawMessage) {
			let event: ClientEvent;
			try {
				if (typeof rawMessage === "string") {
					event = JSON.parse(rawMessage);
				} else if (
					rawMessage instanceof ArrayBuffer ||
					ArrayBuffer.isView(rawMessage)
				) {
					event = JSON.parse(new TextDecoder().decode(rawMessage as ArrayBuffer));
				} else if (typeof rawMessage === "object" && rawMessage !== null) {
					event = rawMessage as ClientEvent;
				} else {
					sendWsError(ws, "PARSE_ERROR", "Invalid JSON");
					return;
				}
			} catch {
				sendWsError(ws, "PARSE_ERROR", "Invalid JSON");
				return;
			}

			if (!event || typeof event !== "object" || typeof event.event !== "string") {
				sendWsError(ws, "INVALID_FORMAT", "Event must have an 'event' field");
				return;
			}

			const wsData = ws.data as unknown as AuthWsData;
			if (!wsData.isAuthenticated) {
			if (
				event.event !== "auth" ||
				typeof event.data !== "object" ||
				!event.data ||
				typeof (event.data as unknown as Record<string, unknown>).token !== "string"
			) {
					sendWsError(ws, "AUTH_REQUIRED", "Authenticate first");
					return;
				}
				await authenticateConnection(ws, (event.data as { token: string }).token, INSTANCE_ID, pubsub);
				return;
			}

			const userId = wsData.userId;
			if (!userId) return;

			const now = Date.now();
			const lastRefresh = wsData.lastPresenceRefresh ?? 0;
			if (now - lastRefresh > 30_000) {
				wsData.lastPresenceRefresh = now;
				await presence.setOnline(userId);
				await userConnections.refresh(userId);
			}

		try {
			switch (event.event) {
				case "auth":
					sendWsError(ws, "ALREADY_AUTHENTICATED", "Connection already authenticated");
					break;
				case "ping":
					ws.send(JSON.stringify(withEventId({ event: "pong" })));
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
						sendWsError(ws, "UNKNOWN_EVENT", "Unknown event");
				}
			} catch (err) {
				console.error(`[GW] Error handling ${event.event}:`, err);
				sendWsError(ws, "INTERNAL_ERROR", "Failed to process event");
			}
		},

		async close(ws) {
			const wsData = ws.data as unknown as AuthWsData;
			if (wsData.authTimeout) {
				clearTimeout(wsData.authTimeout);
				wsData.authTimeout = undefined;
			}
			const { userId, connId } = wsData;
			if (!userId || !connId) return;

			connectionManager.remove(userId, connId);

			if (isShuttingDown) return;

			if (!connectionManager.isLocal(userId)) {
				await pubsub.unsubscribe(userId);
				await userConnections.remove(userId, INSTANCE_ID);
				const stillConnected = await userConnections.isConnected(userId);
				if (stillConnected) {
					console.log(`[GW] ${userId} disconnected locally but still online on another instance`);
					return;
				}
				await presence.setOffline(userId);

				const lastSeen = new Date().toISOString();
				getPresenceSubscribers(userId)
					.then((peerIds) => {
						if (peerIds.length === 0) return;
						const event: ServerEvent = withEventId({
							event: "presence",
							data: { userId, status: "offline", lastSeen },
						});
						const local = peerIds.filter((id) => connectionManager.isLocal(id));
						const remote = peerIds.filter((id) => !connectionManager.isLocal(id));
						connectionManager.sendToUsers(local, event);
						if (remote.length > 0) publishToUsers(remote, event);
					})
					.catch((err) => console.error("[GW] Failed to broadcast offline presence:", err));
			}

			console.log(`[GW] ${userId} disconnected (total: ${connectionManager.getConnectionCount()})`);
		},
	})
	.listen(port);

console.log(`[Gateway] ${INSTANCE_ID} running on ws://localhost:${port}`);

async function gracefulShutdown(signal: string) {
	if (isShuttingDown) return;
	isShuttingDown = true;
	console.log(`[Gateway] ${signal} received, shutting down gracefully...`);

	const onlineUserIds = connectionManager.getOnlineUserIds();

	for (const userId of onlineUserIds) {
		try {
			await userConnections.remove(userId, INSTANCE_ID);
			const stillConnected = await userConnections.isConnected(userId);
			if (!stillConnected) {
				await presence.setOffline(userId);
			}
		} catch {}
	}

	for (const userId of onlineUserIds) {
		const conns = connectionManager.getConnections(userId);
		for (const ws of conns) {
			try { ws.close(1001, "Server shutting down"); } catch {}
		}
	}

	await pubsub.shutdown().catch(() => {});
	await disconnectRedis().catch(() => {});
	await disconnectScylla().catch(() => {});
	try { app.stop(); } catch {}
	console.log(`[Gateway] Shutdown complete`);
	process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
