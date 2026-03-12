import type { ClientEvent, ServerEvent } from "@yam/shared";
import { Limits } from "@yam/shared";
import { useCallback, useEffect, useRef } from "react";
import { env } from "@/env";
import { queryClient } from "@/lib/queryClient";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";
import { setGlobalStatus } from "./ws/connection-status";
import { handleServerEvent } from "./ws/event-handlers";

export { useConnectionStatus } from "./ws/connection-status";

const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_OFFLINE_BUFFER = 300;
const MAX_EVENT_DEDUP = 1000;

export function useWebSocket() {
	const wsRef = useRef<WebSocket | null>(null);
	const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reconnectAttempts = useRef(0);
	const offlineBufferRef = useRef<ClientEvent[]>([]);
	const eventDedupRef = useRef<Set<string>>(new Set());
	const eventOrderRef = useRef<string[]>([]);
	const { isAuthenticated } = useAuthStore();
	const storeRef = useRef(useChatStore.getState());
	const authRetryRef = useRef(0);

	useEffect(() => {
		return useChatStore.subscribe((state) => {
			storeRef.current = state;
		});
	}, []);

	const handleEvent = useCallback((event: ServerEvent) => {
		handleServerEvent(event, storeRef.current);
	}, []);

	const flushOfflineBuffer = useCallback((ws: WebSocket) => {
		while (offlineBufferRef.current.length > 0) {
			if (ws.readyState !== WebSocket.OPEN) break;
			const event = offlineBufferRef.current.shift();
			if (event) ws.send(JSON.stringify(event));
		}
	}, []);

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
		const ws = new WebSocket(`${protocol}//${window.location.host}${env.wsBase}`);
		wsRef.current = ws;

		ws.onopen = () => {
			console.log("[WS] Socket opened, authenticating...");
			const currentToken = localStorage.getItem("accessToken");
			ws.send(JSON.stringify({ event: "auth", data: { token: currentToken ?? token } }));
		};

		ws.onmessage = (e) => {
			try {
				const event = JSON.parse(e.data) as ServerEvent;

				if (event.eventId) {
					if (eventDedupRef.current.has(event.eventId)) return;
					eventDedupRef.current.add(event.eventId);
					eventOrderRef.current.push(event.eventId);
					if (eventOrderRef.current.length > MAX_EVENT_DEDUP) {
						const stale = eventOrderRef.current.shift();
						if (stale) eventDedupRef.current.delete(stale);
					}
				}

				if (event.event === "auth:ok") {
					const wasReconnect = reconnectAttempts.current > 0;
					setGlobalStatus("connected");
					storeRef.current.setWsError(null);
					reconnectAttempts.current = 0;
					authRetryRef.current = 0;
					flushOfflineBuffer(ws);

					if (heartbeatRef.current) clearInterval(heartbeatRef.current);
					heartbeatRef.current = setInterval(() => {
						if (ws.readyState === WebSocket.OPEN) {
							ws.send(JSON.stringify({ event: "ping" }));
						}
					}, Limits.HEARTBEAT_INTERVAL_MS);

					if (wasReconnect) {
						void queryClient.invalidateQueries({ queryKey: ["inbox"] });
						const activeChatId = useChatStore.getState().activeChatId;
						if (activeChatId) {
							void queryClient.invalidateQueries({ queryKey: ["messages", activeChatId] });
						}
					}
					return;
				}

				if (event.event === "error" && event.data.code === "ACCOUNT_SUSPENDED") {
					useAuthStore.getState().logout();
					window.location.href = "/login?reason=suspended";
					return;
				}

				if (
					event.event === "error" &&
					(event.data.code === "AUTH_FAILED" || event.data.code === "AUTH_TIMEOUT")
				) {
					if (authRetryRef.current < 2) {
						authRetryRef.current += 1;
						ws.onclose = null;
						ws.close();
						const refreshToken = localStorage.getItem("refreshToken");
						if (refreshToken) {
							fetch(`${env.apiBase}/auth/refresh`, {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ refreshToken }),
							})
								.then((res) => {
									if (!res.ok) throw new Error("Refresh failed");
									return res.json();
								})
								.then((data) => {
									localStorage.setItem("accessToken", data.accessToken);
									localStorage.setItem("refreshToken", data.refreshToken);
									connect();
								})
								.catch(() => {
									useAuthStore.getState().logout();
									window.location.href = "/login";
								});
							return;
						}
					}
					useAuthStore.getState().logout();
					window.location.href = "/login";
					return;
				}

				if (event.event === "error" && event.data.code === "AUTH_REQUIRED") {
					useAuthStore.getState().logout();
					window.location.href = "/login";
					return;
				}

				handleEvent(event);
			} catch (err) {
				console.error("[WS] Parse error:", err);
			}
		};

		ws.onclose = () => {
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
				if (event.event === "message:read") {
					offlineBufferRef.current = offlineBufferRef.current.filter(
						(item) => !(item.event === "message:read" && item.data.chatId === event.data.chatId),
					);
				}
				offlineBufferRef.current.push(event);
				if (offlineBufferRef.current.length > MAX_OFFLINE_BUFFER) {
					offlineBufferRef.current.splice(0, offlineBufferRef.current.length - MAX_OFFLINE_BUFFER);
				}
			}
		}
	}, []);

	useEffect(() => {
		if (isAuthenticated) connect();

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

	useEffect(() => {
		const handleVisibilityChange = () => {
			if (document.hidden) return;
			if (wsRef.current?.readyState !== WebSocket.OPEN && useAuthStore.getState().isAuthenticated) {
				connect();
			}
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
	}, [connect]);

	return { send };
}
