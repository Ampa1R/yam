import type { InboxItem, Message } from "@yam/shared";
import { Limits, MessageStatus } from "@yam/shared";
import { create } from "zustand";

interface PendingMessage {
	clientId: string;
	chatId: string;
	message: Message;
}

interface PresenceInfo {
	isOnline: boolean;
	lastSeen: string | null;
	updatedAt?: number;
}

interface WsErrorInfo {
	code: string;
	message: string;
	severity?: "info" | "warning" | "error";
	retryable?: boolean;
	scope?: "auth" | "chat" | "message" | "system";
}

interface ChatState {
	activeChatId: string | null;
	inbox: InboxItem[];
	messages: Map<string, Message[]>;
	typingUsers: Map<string, Map<string, ReturnType<typeof setTimeout>>>;
	pendingMessages: Map<string, PendingMessage>;
	presence: Map<string, PresenceInfo>;
	messageStatuses: Map<string, number>;
	wsError: WsErrorInfo | null;

	setActiveChatId: (chatId: string | null) => void;
	setInbox: (inbox: InboxItem[]) => void;
	updateInboxItem: (chatId: string, updates: Partial<InboxItem>) => void;
	addInboxItem: (item: InboxItem) => void;
	togglePin: (chatId: string) => void;
	setMessages: (chatId: string, messages: Message[]) => void;
	addMessage: (chatId: string, message: Message) => void;
	addOptimisticMessage: (clientId: string, chatId: string, message: Message) => void;
	confirmMessage: (clientId: string, messageId: string, createdAt: string) => void;
	updateMessage: (chatId: string, messageId: string, updates: Partial<Message>) => void;
	removeMessage: (chatId: string, messageId: string) => void;
	setTyping: (chatId: string, userId: string, isTyping: boolean) => void;
	getTypingUserIds: (chatId: string) => string[];
	prependMessages: (chatId: string, messages: Message[]) => void;
	setPresence: (userId: string, info: PresenceInfo) => void;
	getPresence: (userId: string) => PresenceInfo;
	setMessageStatus: (messageId: string, status: number) => void;
	getMessageStatus: (messageId: string) => number;
	setWsError: (error: WsErrorInfo | null) => void;
	clearChat: (chatId: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
	activeChatId: null,
	inbox: [],
	messages: new Map(),
	typingUsers: new Map(),
	pendingMessages: new Map(),
	presence: new Map(),
	messageStatuses: new Map(),
	wsError: null,

	setActiveChatId: (chatId) => set({ activeChatId: chatId }),

	setInbox: (apiInbox) =>
		set((state) => {
			const localMap = new Map(state.inbox.map((item) => [item.chatId, item]));
			const apiIds = new Set(apiInbox.map((item) => item.chatId));

		const merged = apiInbox.map((apiItem) => {
			const local = localMap.get(apiItem.chatId);
			if (!local) return apiItem;

			const localTime = new Date(local.lastActivity).getTime();
			const apiTime = new Date(apiItem.lastActivity).getTime();

			if (localTime >= apiTime && local.lastMsgPreview && !apiItem.lastMsgPreview) {
				return {
					...apiItem,
					lastMsgPreview: local.lastMsgPreview,
					lastMsgSender: local.lastMsgSender,
					lastMsgType: local.lastMsgType,
					lastActivity: local.lastActivity,
					unreadCount: local.unreadCount,
				};
			}

			if (localTime > apiTime) {
				return {
					...apiItem,
					lastMsgPreview: local.lastMsgPreview,
					lastMsgSender: local.lastMsgSender,
					lastMsgType: local.lastMsgType,
					lastActivity: local.lastActivity,
					unreadCount: local.unreadCount,
				};
			}

			if (local.unreadCount === 0 && apiItem.unreadCount > 0 && apiTime <= localTime) {
				return { ...apiItem, unreadCount: 0 };
			}

			return apiItem;
		});

			const WS_ONLY_RETENTION_MS = 30_000;
			const now = Date.now();
			for (const [chatId, local] of localMap) {
				if (apiIds.has(chatId)) continue;
				const age = now - new Date(local.lastActivity).getTime();
				if (age < WS_ONLY_RETENTION_MS) {
					merged.push(local);
				}
			}

			merged.sort((a, b) => {
				if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
				return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
			});

			return { inbox: merged };
		}),

	updateInboxItem: (chatId, updates) =>
		set((state) => {
			const updated = state.inbox.map((item) =>
				item.chatId === chatId ? { ...item, ...updates } : item,
			);
			updated.sort((a, b) => {
				if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
				return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
			});
			return { inbox: updated };
		}),

	addInboxItem: (item) =>
		set((state) => {
			const exists = state.inbox.some((i) => i.chatId === item.chatId);
			if (exists) return state;
			return { inbox: [item, ...state.inbox] };
		}),

	togglePin: (chatId) =>
		set((state) => ({
			inbox: state.inbox
				.map((item) =>
					item.chatId === chatId ? { ...item, isPinned: !item.isPinned } : item,
				)
				.sort((a, b) => {
					if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
					return (
						new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
					);
				}),
		})),

	setMessages: (chatId, messages) =>
		set((state) => {
			const newMap = new Map(state.messages);
			newMap.set(chatId, messages);
			return { messages: newMap };
		}),

	addMessage: (chatId, message) =>
		set((state) => {
			const newMap = new Map(state.messages);
			const existing = newMap.get(chatId) ?? [];
			const isDuplicate = existing.some((m) => m.id === message.id);
			if (isDuplicate) return state;
			newMap.set(chatId, [...existing, message]);
			return { messages: newMap };
		}),

	addOptimisticMessage: (clientId, chatId, message) =>
		set((state) => {
			const newMessages = new Map(state.messages);
			const existing = newMessages.get(chatId) ?? [];
			newMessages.set(chatId, [...existing, message]);

			const newPending = new Map(state.pendingMessages);
			newPending.set(clientId, { clientId, chatId, message });

			return { messages: newMessages, pendingMessages: newPending };
		}),

	confirmMessage: (clientId, messageId, createdAt) =>
		set((state) => {
			const pending = state.pendingMessages.get(clientId);
			if (!pending) return state;

			const newMessages = new Map(state.messages);
			const chatMsgs = newMessages.get(pending.chatId);
			if (chatMsgs) {
				newMessages.set(
					pending.chatId,
					chatMsgs.map((m) =>
						m.id === pending.message.id ? { ...m, id: messageId, createdAt } : m,
					),
				);
			}

			const newPending = new Map(state.pendingMessages);
			newPending.delete(clientId);

			const newStatuses = new Map(state.messageStatuses);
			newStatuses.set(messageId, MessageStatus.SENT);

			return { messages: newMessages, pendingMessages: newPending, messageStatuses: newStatuses };
		}),

	updateMessage: (chatId, messageId, updates) =>
		set((state) => {
			const newMap = new Map(state.messages);
			const existing = newMap.get(chatId);
			if (!existing) return state;
			newMap.set(
				chatId,
				existing.map((m) => (m.id === messageId ? { ...m, ...updates } : m)),
			);
			return { messages: newMap };
		}),

	removeMessage: (chatId, messageId) =>
		set((state) => {
			const newMap = new Map(state.messages);
			const existing = newMap.get(chatId);
			if (!existing) return state;
			newMap.set(
				chatId,
				existing.map((m) =>
					m.id === messageId ? { ...m, isDeleted: true, content: "" } : m,
				),
			);
			return { messages: newMap };
		}),

	setTyping: (chatId, userId, isTyping) =>
		set((state) => {
			const newMap = new Map(state.typingUsers);
			const chatTimers = new Map(newMap.get(chatId) ?? []);

			const existingTimer = chatTimers.get(userId);
			if (existingTimer) clearTimeout(existingTimer);

			if (isTyping) {
				const timer = setTimeout(() => {
					const s = get();
					const updated = new Map(s.typingUsers);
					const ct = new Map(updated.get(chatId) ?? []);
					ct.delete(userId);
					if (ct.size === 0) {
						updated.delete(chatId);
					} else {
						updated.set(chatId, ct);
					}
					set({ typingUsers: updated });
				}, Limits.TYPING_TTL_SECONDS * 1000 + 500);
				chatTimers.set(userId, timer);
			} else {
				chatTimers.delete(userId);
			}

			if (chatTimers.size === 0) {
				newMap.delete(chatId);
			} else {
				newMap.set(chatId, chatTimers);
			}
			return { typingUsers: newMap };
		}),

	getTypingUserIds: (chatId) => {
		const timers = get().typingUsers.get(chatId);
		if (!timers) return [];
		return Array.from(timers.keys());
	},

	prependMessages: (chatId, messages) =>
		set((state) => {
			const newMap = new Map(state.messages);
			const existing = newMap.get(chatId) ?? [];
			const existingIds = new Set(existing.map((m) => m.id));
			const newMsgs = messages.filter((m) => !existingIds.has(m.id));
			newMap.set(chatId, [...newMsgs, ...existing]);
			return { messages: newMap };
		}),

	setPresence: (userId, info) =>
		set((state) => {
			const existing = state.presence.get(userId);
			const incomingTime = info.updatedAt ?? 0;
			const existingTime = existing?.updatedAt ?? 0;
			if (existing && existingTime > incomingTime) return state;
			const newMap = new Map(state.presence);
			newMap.set(userId, { ...info, updatedAt: incomingTime || Date.now() });
			return { presence: newMap };
		}),

	getPresence: (userId) => {
		return get().presence.get(userId) ?? { isOnline: false, lastSeen: null };
	},

	setMessageStatus: (messageId, status) =>
		set((state) => {
			const current = state.messageStatuses.get(messageId) ?? -1;
			if (status <= current) return state;
			const newMap = new Map(state.messageStatuses);
			newMap.set(messageId, status);
			return { messageStatuses: newMap };
		}),

	getMessageStatus: (messageId) => {
		return get().messageStatuses.get(messageId) ?? MessageStatus.SENT;
	},

	setWsError: (error) => set({ wsError: error }),

	clearChat: (chatId) =>
		set((state) => {
			const newMessages = new Map(state.messages);
			const msgs = newMessages.get(chatId);
			newMessages.delete(chatId);

			const newStatuses = new Map(state.messageStatuses);
			if (msgs) {
				for (const m of msgs) {
					newStatuses.delete(m.id);
				}
			}

			const newTyping = new Map(state.typingUsers);
			newTyping.delete(chatId);

			return { messages: newMessages, messageStatuses: newStatuses, typingUsers: newTyping };
		}),
}));
