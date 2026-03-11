import { randomUUID } from "node:crypto";
import { connectRedis, createPubSubManager, disconnectRedis, presence, publishToUsers, redis, userConnections } from "@yam/db/redis";
import { db, eq, schema } from "@yam/db/pg";
import { connectScylla, disconnectScylla } from "@yam/db/scylla";
import type { ClientEvent, ServerEvent } from "@yam/shared";
import { Elysia } from "elysia";
import { connectionManager, type WsData } from "./connection/manager";
import { handleDeleteMessage, handleEditMessage, handleSendMessage } from "./handlers/message";
import { handleReadMessage } from "./handlers/read";
import { handleTypingStart, handleTypingStop } from "./handlers/typing";
import { getPresenceSubscribers } from "./lib/chat-members";
import { verifyAccessToken } from "@yam/shared/jwt";

import { hostname } from "node:os";

const port = Number(process.env.GATEWAY_PORT ?? 3001);
const INSTANCE_ID = process.env.GATEWAY_INSTANCE_ID ?? `gw-${hostname()}-${port}`;
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS?.split(",").filter(Boolean) ?? [];
const MAX_WS_PAYLOAD = 64 * 1024; // 64 KB
const WS_AUTH_TIMEOUT_MS = 10_000;
let isShuttingDown = false;

interface AuthWsData extends Partial<WsData> {
	isAuthenticated?: boolean;
	authTimeout?: ReturnType<typeof setTimeout>;
	lastPresenceRefresh?: number;
}

function withEventId(event: Omit<ServerEvent, "eventId">): ServerEvent {
	return { ...event, eventId: randomUUID() };
}

type ErrorSeverity = "info" | "warning" | "error";
type ErrorScope = "auth" | "chat" | "message" | "system";

interface WsErrorOptions {
	severity?: ErrorSeverity;
	retryable?: boolean;
	scope?: ErrorScope;
}

const ERROR_DEFAULTS: Record<string, WsErrorOptions> = {
	AUTH_FAILED: { severity: "error", retryable: false, scope: "auth" },
	AUTH_REQUIRED: { severity: "error", retryable: false, scope: "auth" },
	AUTH_TIMEOUT: { severity: "error", retryable: true, scope: "auth" },
	ACCOUNT_SUSPENDED: { severity: "error", retryable: false, scope: "auth" },
	ALREADY_AUTHENTICATED: { severity: "info", retryable: false, scope: "auth" },
	PARSE_ERROR: { severity: "warning", retryable: true, scope: "system" },
	INVALID_FORMAT: { severity: "warning", retryable: true, scope: "system" },
	UNKNOWN_EVENT: { severity: "warning", retryable: false, scope: "system" },
	INTERNAL_ERROR: { severity: "error", retryable: true, scope: "system" },
};

function sendWsError(ws: any, code: string, message: string, opts?: WsErrorOptions): void {
	const defaults = ERROR_DEFAULTS[code] ?? { severity: "error", retryable: false, scope: "system" };
	ws.send(
		JSON.stringify(
			withEventId({
				event: "error",
				data: {
					code,
					message,
					severity: opts?.severity ?? defaults.severity ?? "error",
					retryable: opts?.retryable ?? defaults.retryable ?? false,
					scope: opts?.scope ?? defaults.scope ?? "system",
				},
			}),
		),
	);
}

async function authenticateConnection(ws: any, token: string): Promise<boolean> {
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
	await userConnections.add(userId, INSTANCE_ID);

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

await connectRedis();
await connectScylla();

{
	let cursor = "0";
	let cleaned = 0;
	do {
		const [nextCursor, keys] = await redis.scan(Number(cursor), "MATCH", "user:connections:*", "COUNT", 200);
		cursor = String(nextCursor);
		if (keys.length === 0) continue;

		const pipeline = redis.pipeline();
		for (const key of keys) {
			pipeline.srem(key, INSTANCE_ID);
		}
		await pipeline.exec();

		for (const key of keys) {
			const remaining = await redis.scard(key);
			if (remaining === 0) {
				const userId = key.replace("user:connections:", "");
				await presence.setOffline(userId);
			}
		}
		cleaned += keys.length;
	} while (cursor !== "0");

	if (cleaned > 0) {
		console.log(`[Gateway] Cleaned up stale connections for ${INSTANCE_ID} from ${cleaned} keys`);
	}
}

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
					typeof (event.data as Record<string, unknown>).token !== "string"
				) {
					sendWsError(ws, "AUTH_REQUIRED", "Authenticate first");
					return;
				}
				await authenticateConnection(ws, (event.data as { token: string }).token);
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
