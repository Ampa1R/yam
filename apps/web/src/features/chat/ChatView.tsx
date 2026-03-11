import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Attachment, AttachmentType, ClientEvent, Message } from "@yam/shared";
import { AttachmentType as AttachmentTypeEnum, MessageType } from "@yam/shared";
import { formatDistanceToNow } from "date-fns";
import {
	ArrowDown,
	ArrowLeft,
	Loader2,
	Reply,
	X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import { TypingDots } from "@/components/TypingDots";
import { useThrottleCallback } from "@/hooks/useThrottle";
import { api, eden } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";
import { GroupManageDialog } from "./GroupManageDialog";
import { MessageBubble } from "./MessageBubble";
import { MessageInput } from "./MessageInput";

const EMPTY_MESSAGES: Message[] = [];

interface ChatDetailMember {
	userId: string;
	role: number;
	isPinned: boolean;
	isMuted: boolean;
	joinedAt?: string;
	user: {
		id: string;
		displayName: string;
		username: string | null;
		avatarUrl: string | null;
	};
}

interface ChatDetail {
	chat: {
		id: string;
		type: number;
		name: string | null;
		description: string | null;
		avatarUrl: string | null;
		createdBy: string;
		memberCount: number;
	};
	members: ChatDetailMember[];
	myMembership: unknown;
}

interface MessagesPage {
	messages: Message[];
	nextCursor: string | null;
}

interface Props {
	chatId: string;
	ws: { send: (event: ClientEvent) => void };
}

function estimateMessageSize(message: Message): number {
	if (message.isDeleted) return 44;

	let height = 56;

	if (message.replyTo) height += 30;
	if (message.attachments.length > 0) {
		const imageCount = message.attachments.filter((a) => a.mimeType.startsWith("image/")).length;
		const fileCount = message.attachments.length - imageCount;
		if (imageCount > 0) {
			height += imageCount > 1 ? 200 : 160;
		}
		if (fileCount > 0) {
			height += fileCount * 42;
		}
	}

	if (message.content) {
		const charsPerLine = 34;
		const lineHeight = 20;
		height += Math.max(1, Math.ceil(message.content.length / charsPerLine)) * lineHeight;
	}

	return Math.min(520, Math.max(52, height));
}

export function ChatView({ chatId, ws }: Props) {
	const queryClient = useQueryClient();
	const setMessages = useChatStore((s) => s.setMessages);
	const addOptimisticMessage = useChatStore((s) => s.addOptimisticMessage);
	const setActiveChatId = useChatStore((s) => s.setActiveChatId);
	const chatMessages = useChatStore((s) => s.messages.get(chatId) ?? EMPTY_MESSAGES);
	const typingUserIds = useChatStore(useShallow((s) => s.getTypingUserIds(chatId)));
	const { user } = useAuthStore();
	const scrollRef = useRef<HTMLDivElement>(null);
	const lastReadRef = useRef<string | null>(null);
	const isNearBottomRef = useRef(true);
	const [showScrollDown, setShowScrollDown] = useState(false);
	const [replyTo, setReplyTo] = useState<Message | null>(null);
	const [editingMessage, setEditingMessage] = useState<Message | null>(null);
	const [pendingDelete, setPendingDelete] = useState<{ messageId: string; original: Message; timer: ReturnType<typeof setTimeout> } | null>(null);
	const [showGroupManage, setShowGroupManage] = useState(false);

	const prevChatIdRef = useRef<string | null>(null);
	const measuredHeightsRef = useRef<Map<string, number>>(new Map());
	const seenMessageIds = useRef(new Set<string>());
	const prevPageCountRef = useRef(0);
	const clearChat = useChatStore((s) => s.clearChat);

	useEffect(() => {
		if (prevChatIdRef.current && prevChatIdRef.current !== chatId) {
			clearChat(prevChatIdRef.current);
		}
		prevChatIdRef.current = chatId;
		setReplyTo(null);
		setEditingMessage(null);
		lastReadRef.current = null;
		measuredHeightsRef.current.clear();
		seenMessageIds.current.clear();
		prevPageCountRef.current = 0;
		isNearBottomRef.current = true;
		setShowScrollDown(false);
		void queryClient.invalidateQueries({ queryKey: ["messages", chatId] });
	}, [chatId, clearChat, queryClient]);

	const { data: chatData, isLoading: chatLoading } = useQuery({
		queryKey: ["chat", chatId],
		queryFn: () => eden(api.api.chats({ id: chatId }).get()),
	});

	const {
		data: messagesData,
		isLoading: messagesLoading,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	} = useInfiniteQuery({
		queryKey: ["messages", chatId],
		queryFn: ({ pageParam }) =>
			eden(
				api.api.chats({ id: chatId }).messages.get({
					query: {
						limit: "50",
						cursor: pageParam,
					},
				}),
			),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
	});

	const rowVirtualizer = useVirtualizer({
		count: chatMessages.length,
		getItemKey: (index) => chatMessages[index]?.id ?? index,
		getScrollElement: () => scrollRef.current,
		estimateSize: (index) => {
			const message = chatMessages[index];
			if (!message) return 88;
			return measuredHeightsRef.current.get(message.id) ?? estimateMessageSize(message);
		},
		overscan: 12,
	});
	const virtualRows = rowVirtualizer.getVirtualItems();

	const isPaginatingRef = useRef(false);

	useEffect(() => {
		if (messagesData?.pages) {
			const pageCount = messagesData.pages.length;
			isPaginatingRef.current = pageCount > prevPageCountRef.current && prevPageCountRef.current > 0;
			prevPageCountRef.current = pageCount;

			const apiMessages = messagesData.pages.flatMap((p) => (p as MessagesPage).messages).reverse();
			const existing = useChatStore.getState().messages.get(chatId) ?? [];
			const apiIds = new Set(apiMessages.map((m) => m.id));

			const pendingMessages = useChatStore.getState().pendingMessages;
			const confirmedClientIds: string[] = [];
			for (const [clientId, pending] of pendingMessages) {
				if (pending.chatId !== chatId) continue;
				const matchedByApi = apiMessages.some(
					(api) =>
						api.senderId === pending.message.senderId &&
						api.content === pending.message.content &&
						Math.abs(new Date(api.createdAt).getTime() - new Date(pending.message.createdAt).getTime()) < 30_000,
				);
				if (matchedByApi) {
					confirmedClientIds.push(clientId);
				}
			}
			if (confirmedClientIds.length > 0) {
				const pendingIds = new Set(
					confirmedClientIds
						.map((cid) => pendingMessages.get(cid)?.message.id)
						.filter(Boolean),
				);
				const cleanedExisting = existing.filter((m) => !pendingIds.has(m.id));
				const localOnly = cleanedExisting.filter((m) => !apiIds.has(m.id));
				const merged = localOnly.length > 0
					? [...apiMessages, ...localOnly].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
					: apiMessages;
				setMessages(chatId, merged);
				for (const cid of confirmedClientIds) {
					useChatStore.setState((s) => {
						const np = new Map(s.pendingMessages);
						np.delete(cid);
						return { pendingMessages: np };
					});
				}
			} else {
				const localOnly = existing.filter((m) => !apiIds.has(m.id));
				if (localOnly.length > 0) {
					const merged = [...apiMessages, ...localOnly].sort(
						(a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
					);
					setMessages(chatId, merged);
				} else {
					setMessages(chatId, apiMessages);
				}
			}
		}
	}, [messagesData, chatId, setMessages]);

	useEffect(() => {
		if (measuredHeightsRef.current.size === 0) return;
		const liveIds = new Set(chatMessages.map((m) => m.id));
		for (const key of measuredHeightsRef.current.keys()) {
			if (!liveIds.has(key)) {
				measuredHeightsRef.current.delete(key);
			}
		}
	}, [chatMessages]);

	const sendReadReceipt = useCallback(() => {
		if (chatMessages.length === 0) return;
		if (document.hidden) return;
		if (!isNearBottomRef.current) return;
		const lastMsg = chatMessages[chatMessages.length - 1];
		if (!lastMsg || lastMsg.senderId === user?.id) return;
		if (lastMsg.id === lastReadRef.current) return;
		if (lastMsg.id.startsWith("pending-")) return;

		lastReadRef.current = lastMsg.id;
		useChatStore.getState().updateInboxItem(chatId, { unreadCount: 0 });
		ws.send({
			event: "message:read",
			data: { chatId, messageId: lastMsg.id },
		});
	}, [chatId, chatMessages, user?.id, ws]);

	const onScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;

		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		const wasNearBottom = isNearBottomRef.current;
		isNearBottomRef.current = distanceFromBottom < 100;
		setShowScrollDown(distanceFromBottom > 300);

		if (!wasNearBottom && isNearBottomRef.current) {
			sendReadReceipt();
		}

		if (el.scrollTop < 200 && hasNextPage && !isFetchingNextPage) {
			const prevHeight = el.scrollHeight;
			fetchNextPage()
				.then(() => {
					requestAnimationFrame(() => {
						if (scrollRef.current) {
							scrollRef.current.scrollTop = scrollRef.current.scrollHeight - prevHeight;
						}
					});
				})
				.catch((err) => {
					console.error("Failed to load older messages:", err);
				});
		}
	}, [hasNextPage, isFetchingNextPage, fetchNextPage, sendReadReceipt]);

	const handleScroll = useThrottleCallback(onScroll, 100);

	const scrollToBottom = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
	}, []);

	useEffect(() => {
		if (!isNearBottomRef.current) return;
		const el = scrollRef.current;
		if (!el) return;
		el.scrollTo({
			top: el.scrollHeight,
			behavior: chatMessages.length > 1 ? "smooth" : "auto",
		});
	}, [chatMessages.length]);

	useEffect(() => {
		sendReadReceipt();
	}, [sendReadReceipt]);

	useEffect(() => {
		const handleVisibilityChange = () => {
			if (!document.hidden) sendReadReceipt();
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
	}, [sendReadReceipt]);

	const onTypingStart = useCallback(() => {
		ws.send({ event: "typing:start", data: { chatId } });
	}, [ws, chatId]);

	const onTypingStop = useCallback(() => {
		ws.send({ event: "typing:stop", data: { chatId } });
	}, [ws, chatId]);

	const handleSend = useCallback(
		(
			content: string,
			attachments?: {
				type: number;
				url: string;
				filename: string;
				size: number;
				mimeType: string;
				duration?: number;
				waveform?: number[];
			}[],
		) => {
			if (!user) return;
			const clientId = crypto.randomUUID();

			const isVoice = attachments?.some((a) => a.type === AttachmentTypeEnum.VOICE);
			const msgType = isVoice
				? MessageType.VOICE
				: attachments && attachments.length > 0
					? MessageType.MEDIA
					: MessageType.TEXT;

			const optimisticMessage: Message = {
				id: `pending-${clientId}`,
				chatId,
				bucket: 0,
				senderId: user.id,
				type: msgType,
				content,
				attachments: (attachments ?? []).map((a) => ({
					type: a.type as AttachmentType,
					url: a.url,
					filename: a.filename,
					size: a.size,
					mimeType: a.mimeType,
					width: null,
					height: null,
					duration: a.duration ?? null,
					waveform: a.waveform ?? null,
				})) satisfies Attachment[],
				mediaGroupId: null,
				replyTo: replyTo?.id ?? null,
				isEdited: false,
				isDeleted: false,
				createdAt: new Date().toISOString(),
				editedAt: null,
			};

			addOptimisticMessage(clientId, chatId, optimisticMessage);

			ws.send({
				event: "message:send",
				data: {
					chatId,
					type: msgType,
					content,
					clientId,
					attachments: attachments?.map(({ waveform, duration, ...rest }) => ({
						...rest,
						...(duration != null ? { duration } : {}),
						...(waveform ? { waveform } : {}),
					})),
					replyTo: replyTo?.id,
				},
			});

			setReplyTo(null);
		},
		[chatId, ws, user, addOptimisticMessage, replyTo],
	);

	const updateMessage = useChatStore((s) => s.updateMessage);
	const removeMessage = useChatStore((s) => s.removeMessage);

	const handleEdit = useCallback(
		(content: string) => {
			if (!editingMessage) return;
			updateMessage(chatId, editingMessage.id, { content, isEdited: true, editedAt: new Date().toISOString() });
			ws.send({
				event: "message:edit",
				data: { messageId: editingMessage.id, chatId, content },
			});
			setEditingMessage(null);
		},
		[editingMessage, chatId, ws, updateMessage],
	);

	const commitDelete = useCallback(
		(messageId: string) => {
			ws.send({
				event: "message:delete",
				data: { messageId, chatId },
			});
			setPendingDelete(null);
		},
		[chatId, ws],
	);

	const handleDelete = useCallback(
		(messageId: string) => {
			if (pendingDelete) {
				commitDelete(pendingDelete.messageId);
				clearTimeout(pendingDelete.timer);
			}

			const original = chatMessages.find((m) => m.id === messageId);
			if (!original) return;

			removeMessage(chatId, messageId);

			const timer = setTimeout(() => {
				commitDelete(messageId);
			}, 5000);

			setPendingDelete({ messageId, original, timer });
		},
		[chatId, chatMessages, removeMessage, commitDelete, pendingDelete],
	);

	const undoDelete = useCallback(() => {
		if (!pendingDelete) return;
		clearTimeout(pendingDelete.timer);
		updateMessage(chatId, pendingDelete.messageId, {
			isDeleted: false,
			content: pendingDelete.original.content,
		});
		setPendingDelete(null);
	}, [chatId, pendingDelete, updateMessage]);

	const handleReply = useCallback((msg: Message) => setReplyTo(msg), []);
	const handleStartEdit = useCallback((msg: Message) => setEditingMessage(msg), []);

	const pendingDeleteRef = useRef(pendingDelete);
	pendingDeleteRef.current = pendingDelete;

	useEffect(() => {
		return () => {
			const pd = pendingDeleteRef.current;
			if (pd) {
				clearTimeout(pd.timer);
				ws.send({
					event: "message:delete",
					data: { messageId: pd.messageId, chatId },
				});
			}
		};
	}, [chatId, ws]);

	const chatDetail = chatData as ChatDetail | undefined;
	const chatName = chatDetail?.chat?.name ?? "Chat";
	const memberCount = chatDetail?.members?.length ?? 0;

	const otherMembers = chatDetail?.members?.filter((m) => m.userId !== user?.id) ?? [];
	const displayName =
		chatDetail?.chat?.type === 0 && otherMembers.length > 0
			? (otherMembers[0]?.user?.displayName ?? chatName)
			: chatName;

	useEffect(() => {
		if (!chatDetail?.members) return;
		const setPresence = useChatStore.getState().setPresence;
		for (const m of chatDetail.members) {
			if ("isOnline" in m) {
				setPresence(m.userId, {
					isOnline: (m as ChatDetailMember & { isOnline: boolean }).isOnline,
					lastSeen: null,
					updatedAt: 0,
				});
			}
		}
	}, [chatDetail?.members]);

	const otherUserId = chatDetail?.chat?.type === 0 ? otherMembers[0]?.userId : null;
	const otherPresence = useChatStore(
		(s) => (otherUserId ? (s.presence.get(otherUserId) ?? null) : null),
	);
	const isOtherOnline = otherPresence?.isOnline ?? false;
	const messagesById = useMemo(
		() => new Map(chatMessages.map((message) => [message.id, message])),
		[chatMessages],
	);

	return (
		<div className="flex h-full flex-col bg-chat-bg">
			<header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3">
				<button
					type="button"
					onClick={() => setActiveChatId(null)}
					className="rounded-lg p-1 text-text-secondary hover:bg-surface-hover lg:hidden"
					aria-label="Back to chats"
				>
					<ArrowLeft size={20} />
				</button>
				<div className="relative">
					<div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/20 font-semibold text-primary">
						{displayName.charAt(0).toUpperCase()}
					</div>
					{chatDetail?.chat?.type === 0 && isOtherOnline && (
						<div className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface bg-success" />
					)}
				</div>
				<div>
					<h2 className="font-semibold text-text-primary">{displayName}</h2>
					<p className="text-xs text-text-secondary">
						{typingUserIds.length > 0
							? <TypingDots />
							: chatDetail?.chat?.type === 0
								? isOtherOnline
									? "online"
									: otherPresence?.lastSeen
										? `last seen ${formatDistanceToNow(new Date(otherPresence.lastSeen), { addSuffix: true })}`
										: "offline"
								: <button type="button" onClick={() => setShowGroupManage(true)} className="hover:underline">{memberCount} members</button>}
					</p>
				</div>
			</header>

			<div
				ref={scrollRef}
				onScroll={handleScroll}
				className="relative flex-1 overflow-y-auto px-4 py-4"
			>
				{isFetchingNextPage && (
					<div className="flex items-center justify-center py-4">
						<Loader2 size={20} className="animate-spin text-text-muted" />
					</div>
				)}
				{(chatLoading || messagesLoading) && (
					<div className="flex items-center justify-center py-8">
						<Loader2 size={24} className="animate-spin text-text-muted" />
					</div>
				)}
				<div className="mx-auto max-w-3xl">
					<div className="relative w-full" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
					{virtualRows.map((virtualRow) => {
						const msg = chatMessages[virtualRow.index];
						if (!msg) return null;
						const replyToMessage = msg.replyTo ? (messagesById.get(msg.replyTo) ?? null) : null;
						const isOwn = msg.senderId === user?.id;
						const isNew = !seenMessageIds.current.has(msg.id);
						if (isNew) seenMessageIds.current.add(msg.id);
						const shouldAnimate = isNew && !isPaginatingRef.current;
						return (
							<div
								key={msg.id}
								ref={(el) => {
									if (!el) return;
									const measured = Math.ceil(el.getBoundingClientRect().height);
									if (measured > 0 && measuredHeightsRef.current.get(msg.id) !== measured) {
										measuredHeightsRef.current.set(msg.id, measured);
									}
									rowVirtualizer.measureElement(el);
								}}
								data-index={virtualRow.index}
								className="absolute left-0 top-0 w-full py-0.5"
								style={{ transform: `translateY(${virtualRow.start}px)` }}
							>
								<motion.div
									initial={shouldAnimate ? { opacity: 0, scale: 0.95, x: isOwn ? 20 : -20 } : false}
									animate={{ opacity: 1, scale: 1, x: 0 }}
									transition={{ type: "spring", damping: 20, stiffness: 300 }}
								>
									<MessageBubble
										message={msg}
										isOwn={isOwn}
										isPending={msg.id.startsWith("pending-")}
										onReply={handleReply}
										onEdit={handleStartEdit}
										onDelete={handleDelete}
										replyToMessage={replyToMessage}
									/>
								</motion.div>
							</div>
						);
					})}
					</div>
				</div>

				<AnimatePresence>
					{showScrollDown && (
						<motion.button
							type="button"
							onClick={scrollToBottom}
							initial={{ scale: 0, opacity: 0 }}
							animate={{ scale: 1, opacity: 1 }}
							exit={{ scale: 0, opacity: 0 }}
							transition={{ type: "spring", damping: 15 }}
							className="absolute bottom-4 right-4 flex h-10 w-10 items-center justify-center rounded-full bg-surface shadow-lg hover:bg-surface-hover"
							aria-label="Scroll to bottom"
						>
							<ArrowDown size={18} className="text-text-secondary" />
						</motion.button>
					)}
				</AnimatePresence>
			</div>

			<AnimatePresence>
				{replyTo && (
					<motion.div
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ type: "spring", damping: 25, stiffness: 300 }}
						className="overflow-hidden border-t border-border bg-surface-secondary"
					>
						<div className="flex items-center gap-3 px-4 py-2">
							<Reply size={16} className="shrink-0 text-primary" />
							<div className="min-w-0 flex-1">
								<p className="truncate text-xs font-medium text-primary">Reply to message</p>
								<p className="truncate text-xs text-text-secondary">
									{replyTo.isDeleted ? "Message deleted" : (replyTo.content || "Attachment")}
								</p>
							</div>
							<button
								type="button"
								onClick={() => setReplyTo(null)}
								className="rounded p-1 hover:bg-surface-hover"
								aria-label="Cancel reply"
							>
								<X size={14} className="text-text-muted" />
							</button>
						</div>
					</motion.div>
				)}
			</AnimatePresence>

			<AnimatePresence>
				{pendingDelete && (
					<motion.div
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ type: "spring", damping: 25, stiffness: 300 }}
						className="overflow-hidden border-t border-border bg-surface-secondary"
					>
						<div className="flex items-center justify-between px-4 py-2">
							<span className="text-sm text-text-secondary">Message deleted</span>
							<button
								type="button"
								onClick={undoDelete}
								className="rounded-lg px-3 py-1 text-sm font-medium text-primary hover:bg-primary/10"
							>
								Undo
							</button>
						</div>
					</motion.div>
				)}
			</AnimatePresence>

			<MessageInput
				onSend={editingMessage ? handleEdit : handleSend}
				onTypingStart={onTypingStart}
				onTypingStop={onTypingStop}
				editingMessage={editingMessage}
				onCancelEdit={() => setEditingMessage(null)}
			/>

			{showGroupManage && chatDetail?.chat?.type === 1 && (
				<GroupManageDialog
					chatId={chatId}
					chatName={chatDetail.chat.name}
					members={chatDetail.members}
					myRole={(chatDetail.members.find((m) => m.userId === user?.id)?.role) ?? 0}
					myUserId={user?.id ?? ""}
					onClose={() => setShowGroupManage(false)}
				/>
			)}
		</div>
	);
}
