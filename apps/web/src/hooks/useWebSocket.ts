import type { ClientEvent, ServerEvent } from "@yam/shared";
import { Limits, MessageType } from "@yam/shared";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { env } from "@/env";
import { queryClient } from "@/lib/queryClient";
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

	useEffect(() => {
		return useChatStore.subscribe((state) => {
			storeRef.current = state;
		});
	}, []);

	const handleEvent = useCallback((event: ServerEvent) => {
		const store = storeRef.current;
		switch (event.event) {
		case "message:new": {
			store.addMessage(event.data.chatId, event.data);
			const preview =
				event.data.content.slice(0, 100) ||
				(event.data.type === MessageType.VOICE ? "🎤 Voice message"
					: event.data.attachments.length > 0 ? "📎 Attachment" : "");
			const isActiveChat = useChatStore.getState().activeChatId === event.data.chatId;
			const currentItem = store.inbox.find((i) => i.chatId === event.data.chatId);
			if (currentItem) {
				const inboxUpdate: Record<string, unknown> = {
					lastMsgPreview: preview,
					lastMsgSender: event.data.senderId,
					lastMsgType: event.data.type,
					lastActivity: event.data.createdAt,
				};
				if (!isActiveChat) {
					inboxUpdate.unreadCount = (currentItem.unreadCount ?? 0) + 1;
				}
				store.updateInboxItem(event.data.chatId, inboxUpdate);
			} else {
				store.addInboxItem({
					chatId: event.data.chatId,
					chatType: 0,
					chatName: null,
					chatAvatar: null,
					otherUserId: event.data.senderId,
					lastMsgSender: event.data.senderId,
					lastMsgType: event.data.type,
					lastMsgPreview: preview,
					lastActivity: event.data.createdAt,
					unreadCount: isActiveChat ? 0 : 1,
					isPinned: false,
					isMuted: false,
				});
				void queryClient.invalidateQueries({ queryKey: ["inbox"] });
			}
			break;
		}
		case "message:ack": {
			const pending = useChatStore.getState().pendingMessages.get(event.data.clientId);
			store.confirmMessage(event.data.clientId, event.data.messageId, event.data.createdAt);
			if (pending) {
				const ackPreview =
					pending.message.content.slice(0, 100) ||
					(pending.message.type === MessageType.VOICE ? "🎤 Voice message"
						: pending.message.attachments.length > 0 ? "📎 Attachment" : "");
				const ackUpdate = {
					lastMsgPreview: ackPreview,
					lastMsgSender: pending.message.senderId,
					lastMsgType: pending.message.type,
					lastActivity: event.data.createdAt,
				};
				store.updateInboxItem(pending.chatId, ackUpdate);
				if (!useChatStore.getState().inbox.some((i) => i.chatId === pending.chatId)) {
					void queryClient.invalidateQueries({ queryKey: ["inbox"] });
				}
			}
			break;
		}
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
				store.setMessageStatus(event.data.messageId, event.data.status);
				break;
			case "typing":
				store.setTyping(event.data.chatId, event.data.userId, event.data.isTyping);
				break;
			case "presence":
				store.setPresence(event.data.userId, {
					isOnline: event.data.status === "online",
					lastSeen: event.data.lastSeen,
					updatedAt: Date.now(),
				});
				break;
			case "chat:updated": {
				const preserveUnread = event.data.unreadCount === -1;
				const existingItem = store.inbox.find((i) => i.chatId === event.data.chatId);
				if (existingItem) {
					const localTime = new Date(existingItem.lastActivity).getTime();
					const eventTime = event.data.lastMessage
						? new Date(event.data.lastMessage.createdAt).getTime()
						: 0;
					const shouldUpdatePreview = preserveUnread || eventTime > localTime;
					if (shouldUpdatePreview) {
						const unreadUpdate = preserveUnread
							? {}
							: useChatStore.getState().activeChatId === event.data.chatId
								? { unreadCount: 0 }
								: existingItem.unreadCount === 0 && event.data.unreadCount > 0
									? {}
									: { unreadCount: event.data.unreadCount };
						store.updateInboxItem(event.data.chatId, {
							...unreadUpdate,
							...(event.data.lastMessage && {
								lastMsgPreview: event.data.lastMessage.preview,
								lastMsgSender: event.data.lastMessage.senderId,
								lastMsgType: event.data.lastMessage.type,
								lastActivity: event.data.lastMessage.createdAt,
							}),
							...(!event.data.lastMessage && preserveUnread && { lastMsgPreview: "Message deleted" }),
						});
					}
				} else if (!preserveUnread) {
					void queryClient.invalidateQueries({ queryKey: ["inbox"] });
				}
				break;
			}
			case "pong":
				break;
			case "error": {
				const errData = event.data;
				if (errData.severity === "info") break;
				store.setWsError({
					code: errData.code,
					message: errData.message,
					severity: errData.severity,
					retryable: errData.retryable,
					scope: errData.scope,
				});
				if (errData.severity === "error") {
					console.error("[WS] Server error:", errData);
				}
				break;
			}
		}
	}, []);

	const flushOfflineBuffer = useCallback((ws: WebSocket) => {
		while (offlineBufferRef.current.length > 0) {
			if (ws.readyState !== WebSocket.OPEN) break;
			const event = offlineBufferRef.current.shift();
			if (event) ws.send(JSON.stringify(event));
		}
	}, []);

	const authRetryRef = useRef(0);

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
					if (eventDedupRef.current.has(event.eventId)) {
						return;
					}
					eventDedupRef.current.add(event.eventId);
					eventOrderRef.current.push(event.eventId);
					if (eventOrderRef.current.length > MAX_EVENT_DEDUP) {
						const stale = eventOrderRef.current.shift();
						if (stale) eventDedupRef.current.delete(stale);
					}
				}
				if (event.event === "auth:ok") {
					console.log("[WS] Authenticated");
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
					console.error("[WS] Account suspended");
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
						console.log("[WS] Auth failed, attempting token refresh...");
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
									console.error("[WS] Token refresh failed, logging out");
									useAuthStore.getState().logout();
									window.location.href = "/login";
								});
							return;
						}
					}
					console.error("[WS] Auth terminal error:", event.data);
					useAuthStore.getState().logout();
					window.location.href = "/login";
					return;
				}
				if (event.event === "error" && event.data.code === "AUTH_REQUIRED") {
					console.error("[WS] Auth required:", event.data);
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
