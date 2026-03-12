import type { Message, ServerEvent } from "@yam/shared";
import { MessageType } from "@yam/shared";
import { queryClient } from "@/lib/queryClient";
import type { ChatState } from "@/stores/chat";
import { useChatStore } from "@/stores/chat";

function getMessagePreview(msg: Pick<Message, "content" | "type" | "attachments">): string {
	if (msg.content) return msg.content.slice(0, 100);
	if (msg.type === MessageType.VOICE) return "🎤 Voice message";
	if (msg.attachments.length > 0) return "📎 Attachment";
	return "";
}

function resolveUnreadCount(
	chatId: string,
	existingUnread: number,
	eventUnread: number,
	preserveUnread: boolean,
): Partial<{ unreadCount: number }> {
	if (preserveUnread) return {};
	if (useChatStore.getState().activeChatId === chatId) return { unreadCount: 0 };
	if (existingUnread === 0 && eventUnread > 0) return {};
	return { unreadCount: eventUnread };
}

export function handleServerEvent(event: ServerEvent, store: ChatState): void {
	switch (event.event) {
		case "message:new": {
			store.addMessage(event.data.chatId, event.data);
			const preview = getMessagePreview(event.data);
			const isActiveChat = useChatStore.getState().activeChatId === event.data.chatId;
			const currentItem = store.inbox.find((i) => i.chatId === event.data.chatId);

			if (currentItem) {
				store.updateInboxItem(event.data.chatId, {
					lastMsgPreview: preview,
					lastMsgSender: event.data.senderId,
					lastMsgType: event.data.type,
					lastActivity: event.data.createdAt,
					...(!isActiveChat && { unreadCount: (currentItem.unreadCount ?? 0) + 1 }),
				});
			} else {
				store.addInboxItem({
					chatId: event.data.chatId,
					chatType: event.data.chatType,
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
				const preview = getMessagePreview(pending.message);
				store.updateInboxItem(pending.chatId, {
					lastMsgPreview: preview,
					lastMsgSender: pending.message.senderId,
					lastMsgType: pending.message.type,
					lastActivity: event.data.createdAt,
				});
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
			if (!existingItem) {
				if (!preserveUnread) {
					void queryClient.invalidateQueries({ queryKey: ["inbox"] });
				}
				break;
			}

			const localTime = new Date(existingItem.lastActivity).getTime();
			const eventTime = event.data.lastMessage
				? new Date(event.data.lastMessage.createdAt).getTime()
				: 0;

			if (!preserveUnread && eventTime <= localTime) break;

			const unreadUpdate = resolveUnreadCount(
				event.data.chatId,
				existingItem.unreadCount,
				event.data.unreadCount,
				preserveUnread,
			);

			const lastMsg = event.data.lastMessage;
			const previewUpdate = lastMsg
				? {
						lastMsgPreview: lastMsg.preview,
						lastMsgSender: lastMsg.senderId,
						lastMsgType: lastMsg.type,
						lastActivity: lastMsg.createdAt,
					}
				: preserveUnread
					? { lastMsgPreview: "Message deleted" }
					: {};

			store.updateInboxItem(event.data.chatId, {
				...unreadUpdate,
				...previewUpdate,
			});
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
}
