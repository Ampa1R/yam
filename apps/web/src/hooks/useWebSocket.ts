import type { ClientEvent, ServerEvent } from "@yam/shared";
import { Limits } from "@yam/shared";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { env } from "@/env";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";

type ConnectionStatus = "connected" | "connecting" | "disconnected";

let globalStatus: ConnectionStatus = "disconnected";
const statusListeners = new Set<() => void>();

function setGlobalStatus(status: ConnectionStatus) {
	globalStatus = status;
	for (const listener of statusListeners) listener();
}

export function useConnectionStatus(): ConnectionStatus {
	return useSyncExternalStore(
		(cb) => {
			statusListeners.add(cb);
			return () => statusListeners.delete(cb);
		},
		() => globalStatus,
	);
}

const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

export function useWebSocket() {
	const wsRef = useRef<WebSocket | null>(null);
	const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reconnectAttempts = useRef(0);
	const offlineBufferRef = useRef<ClientEvent[]>([]);
	const { isAuthenticated } = useAuthStore();
	const storeRef = useRef(useChatStore.getState());

	useEffect(() => {
		return useChatStore.subscribe((state) => {
			storeRef.current = state;
		});
	}, []);

	const handleEvent = useCallback((event: ServerEvent) => {
		const store = storeRef.current;
		switch (event.event) {
			case "message:new":
				store.addMessage(event.data.chatId, event.data);
				break;
			case "message:ack":
				store.confirmMessage(event.data.clientId, event.data.messageId, event.data.createdAt);
				break;
			case "message:updated":
				store.updateMessage(event.data.chatId, event.data.messageId, {
					content: event.data.content,
					isEdited: true,
					editedAt: event.data.editedAt,
				});
				break;
			case "message:deleted":
				store.removeMessage(event.data.chatId, event.data.messageId);
				break;
			case "message:status":
				store.updateMessage(event.data.chatId, event.data.messageId, {});
				break;
			case "typing":
				store.setTyping(event.data.chatId, event.data.userId, event.data.isTyping);
				break;
			case "presence":
				store.setPresence(event.data.userId, {
					isOnline: event.data.status === "online",
					lastSeen: event.data.lastSeen,
				});
				break;
			case "chat:updated":
				store.updateInboxItem(event.data.chatId, {
					unreadCount: event.data.unreadCount,
					...(event.data.lastMessage && {
						lastMsgPreview: event.data.lastMessage.preview,
						lastMsgSender: event.data.lastMessage.senderId,
						lastMsgType: event.data.lastMessage.type,
						lastActivity: event.data.lastMessage.createdAt,
					}),
				});
				break;
			case "pong":
				break;
			case "error":
				console.error("[WS] Server error:", event.data);
				break;
		}
	}, []);

	const flushOfflineBuffer = useCallback(
		(ws: WebSocket) => {
			while (offlineBufferRef.current.length > 0) {
				const event = offlineBufferRef.current.shift();
				if (event && ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify(event));
				}
			}
		},
		[],
	);

	const connect = useCallback(() => {
		const token = localStorage.getItem("accessToken");
		if (!token) return;

		if (
			wsRef.current?.readyState === WebSocket.OPEN ||
			wsRef.current?.readyState === WebSocket.CONNECTING
		) {
			return;
		}

		setGlobalStatus("connecting");

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${protocol}//${window.location.host}${env.wsBase}?token=${token}`);
		wsRef.current = ws;

		ws.onopen = () => {
			console.log("[WS] Connected");
			setGlobalStatus("connected");
			reconnectAttempts.current = 0;
			flushOfflineBuffer(ws);

			heartbeatRef.current = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ event: "ping" }));
				}
			}, Limits.HEARTBEAT_INTERVAL_MS);
		};

		ws.onmessage = (e) => {
			try {
				const event = JSON.parse(e.data) as ServerEvent;
				handleEvent(event);
			} catch (err) {
				console.error("[WS] Parse error:", err);
			}
		};

		ws.onclose = () => {
			console.log("[WS] Disconnected");
			setGlobalStatus("disconnected");
			if (heartbeatRef.current) clearInterval(heartbeatRef.current);

			if (!useAuthStore.getState().isAuthenticated) return;

			const base = Math.min(
				BASE_RECONNECT_DELAY_MS * 2 ** reconnectAttempts.current,
				MAX_RECONNECT_DELAY_MS,
			);
			const jitter = base * (0.5 + Math.random() * 0.5);
			reconnectAttempts.current++;
			reconnectRef.current = setTimeout(connect, jitter);
		};

		ws.onerror = (err) => {
			console.error("[WS] Error:", err);
		};
	}, [handleEvent, flushOfflineBuffer]);

	const send = useCallback((event: ClientEvent) => {
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify(event));
		} else {
			const bufferable = event.event === "message:send" || event.event === "message:read";
			if (bufferable) {
				offlineBufferRef.current.push(event);
			}
		}
	}, []);

	useEffect(() => {
		if (isAuthenticated) {
			connect();
		}

		return () => {
			if (heartbeatRef.current) clearInterval(heartbeatRef.current);
			if (reconnectRef.current) clearTimeout(reconnectRef.current);
			if (wsRef.current) {
				wsRef.current.onclose = null;
				wsRef.current.close();
			}
			setGlobalStatus("disconnected");
		};
	}, [isAuthenticated, connect]);

	return { send };
}
