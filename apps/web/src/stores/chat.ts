import type { InboxItem, Message } from "@yam/shared";
import { create } from "zustand";

interface PendingMessage {
	clientId: string;
	chatId: string;
	message: Message;
}

interface ChatState {
	activeChatId: string | null;
	inbox: InboxItem[];
	messages: Map<string, Message[]>;
	typingUsers: Map<string, Set<string>>;
	pendingMessages: Map<string, PendingMessage>;

	setActiveChatId: (chatId: string | null) => void;
	setInbox: (inbox: InboxItem[]) => void;
	updateInboxItem: (chatId: string, updates: Partial<InboxItem>) => void;
	setMessages: (chatId: string, messages: Message[]) => void;
	addMessage: (chatId: string, message: Message) => void;
	addOptimisticMessage: (clientId: string, chatId: string, message: Message) => void;
	confirmMessage: (clientId: string, messageId: string, createdAt: string) => void;
	updateMessage: (chatId: string, messageId: string, updates: Partial<Message>) => void;
	removeMessage: (chatId: string, messageId: string) => void;
	setTyping: (chatId: string, userId: string, isTyping: boolean) => void;
	prependMessages: (chatId: string, messages: Message[]) => void;
}

export const useChatStore = create<ChatState>((set, _get) => ({
	activeChatId: null,
	inbox: [],
	messages: new Map(),
	typingUsers: new Map(),
	pendingMessages: new Map(),

	setActiveChatId: (chatId) => set({ activeChatId: chatId }),

	setInbox: (inbox) => set({ inbox }),

	updateInboxItem: (chatId, updates) =>
		set((state) => ({
			inbox: state.inbox.map((item) => (item.chatId === chatId ? { ...item, ...updates } : item)),
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

			return { messages: newMessages, pendingMessages: newPending };
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
				existing.map((m) => (m.id === messageId ? { ...m, isDeleted: true, content: "" } : m)),
			);
			return { messages: newMap };
		}),

	setTyping: (chatId, userId, isTyping) =>
		set((state) => {
			const newMap = new Map(state.typingUsers);
			const chatTyping = new Set(newMap.get(chatId) ?? []);
			if (isTyping) {
				chatTyping.add(userId);
			} else {
				chatTyping.delete(userId);
			}
			newMap.set(chatId, chatTyping);
			return { typingUsers: newMap };
		}),

	prependMessages: (chatId, messages) =>
		set((state) => {
			const newMap = new Map(state.messages);
			const existing = newMap.get(chatId) ?? [];
			newMap.set(chatId, [...messages, ...existing]);
			return { messages: newMap };
		}),
}));
