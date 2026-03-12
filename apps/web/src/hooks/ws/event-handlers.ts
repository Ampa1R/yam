import type { ServerEvent } from "@yam/shared";
import { MessageType } from "@yam/shared";
import { queryClient } from "@/lib/queryClient";
import type { ChatState } from "@/stores/chat";
import { useChatStore } from "@/stores/chat";

export function handleServerEvent(event: ServerEvent, store: ChatState): void {
	switch (event.event) {
		case "message:new": {
			store.addMessage(event.data.chatId, event.data);
			const preview =
				event.data.content.slice(0, 100) ||
				(event.data.type === MessageType.VOICE
					? "🎤 Voice message"
					: event.data.attachments.length > 0
						? "📎 Attachment"
						: "");
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
				const ackPreview =
					pending.message.content.slice(0, 100) ||
					(pending.message.type === MessageType.VOICE
						? "🎤 Voice message"
						: pending.message.attachments.length > 0
							? "📎 Attachment"
							: "");
				store.updateInboxItem(pending.chatId, {
					lastMsgPreview: ackPreview,
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
}
