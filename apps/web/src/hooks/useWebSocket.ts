import type { ClientEvent, ServerEvent } from "@yam/shared";
import { Limits } from "@yam/shared";
import { useCallback, useEffect, useRef } from "react";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";

export function useWebSocket() {
	const wsRef = useRef<WebSocket | null>(null);
	const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reconnectAttempts = useRef(0);
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

	const connect = useCallback(() => {
		const token = localStorage.getItem("accessToken");
		if (!token) return;

		if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
			return;
		}

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${token}`);
		wsRef.current = ws;

		ws.onopen = () => {
			console.log("[WS] Connected");
			reconnectAttempts.current = 0;

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
			if (heartbeatRef.current) clearInterval(heartbeatRef.current);

			if (!useAuthStore.getState().isAuthenticated) return;

			const delay = Math.min(1000 * 2 ** reconnectAttempts.current, 30000);
			reconnectAttempts.current++;
			reconnectRef.current = setTimeout(connect, delay);
		};

		ws.onerror = (err) => {
			console.error("[WS] Error:", err);
		};
	}, [handleEvent]);

	const send = useCallback((event: ClientEvent) => {
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify(event));
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
		};
	}, [isAuthenticated, connect]);

	return { send };
}
