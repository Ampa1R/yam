import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
	Attachment,
	AttachmentType,
	Chat,
	ChatMember,
	ClientEvent,
	Message,
} from "@yam/shared";
import {
	ArrowDown,
	ArrowLeft,
	CheckCheck,
	Edit2,
	Loader2,
	Reply,
	Trash2,
	X,
} from "lucide-react";
import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";
import { MessageInput } from "./MessageInput";

interface ChatDetailResponse {
	chat: Chat;
	members: (ChatMember & { user: { id: string; displayName: string } })[];
	myMembership: ChatMember;
}

interface MessagesResponse {
	messages: Message[];
	nextCursor: string | null;
}

interface Props {
	chatId: string;
	ws: { send: (event: ClientEvent) => void };
}

export function ChatView({ chatId, ws }: Props) {
	const {
		messages,
		setMessages,
		addOptimisticMessage,
		prependMessages,
		setActiveChatId,
	} = useChatStore();
	const typingUserIds = useChatStore((s) => s.getTypingUserIds(chatId));
	const { user } = useAuthStore();
	const scrollRef = useRef<HTMLDivElement>(null);
	const lastReadRef = useRef<string | null>(null);
	const chatMessages = messages.get(chatId) ?? [];
	const isNearBottomRef = useRef(true);
	const [showScrollDown, setShowScrollDown] = useState(false);
	const [replyTo, setReplyTo] = useState<Message | null>(null);
	const [editingMessage, setEditingMessage] = useState<Message | null>(null);

	const { data: chatData, isLoading: chatLoading } = useQuery({
		queryKey: ["chat", chatId],
		queryFn: () => api.get<ChatDetailResponse>(`/chats/${chatId}`),
	});

	const {
		data: messagesData,
		isLoading: messagesLoading,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	} = useInfiniteQuery({
		queryKey: ["messages", chatId],
		queryFn: ({ pageParam }) => {
			const params = new URLSearchParams({ limit: "50" });
			if (pageParam) params.set("before", pageParam);
			return api.get<MessagesResponse>(`/chats/${chatId}/messages?${params}`);
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
	});

	useEffect(() => {
		if (messagesData?.pages) {
			const allMessages = messagesData.pages.flatMap((p) => p.messages).reverse();
			setMessages(chatId, allMessages);
		}
	}, [messagesData, chatId, setMessages]);

	const handleScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;

		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		isNearBottomRef.current = distanceFromBottom < 100;
		setShowScrollDown(distanceFromBottom > 300);

		if (el.scrollTop < 200 && hasNextPage && !isFetchingNextPage) {
			const prevHeight = el.scrollHeight;
			fetchNextPage().then(() => {
				requestAnimationFrame(() => {
					if (scrollRef.current) {
						scrollRef.current.scrollTop = scrollRef.current.scrollHeight - prevHeight;
					}
				});
			});
		}
	}, [hasNextPage, isFetchingNextPage, fetchNextPage]);

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
		if (chatMessages.length === 0) return;
		const lastMsg = chatMessages[chatMessages.length - 1];
		if (!lastMsg || lastMsg.senderId === user?.id) return;
		if (lastMsg.id === lastReadRef.current) return;
		if (lastMsg.id.startsWith("pending-")) return;

		lastReadRef.current = lastMsg.id;
		ws.send({
			event: "message:read",
			data: { chatId, messageId: lastMsg.id },
		});
	}, [chatId, chatMessages, user?.id, ws]);

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
			}[],
		) => {
			if (!user) return;
			const clientId = crypto.randomUUID();
			const msgType = attachments && attachments.length > 0 ? 1 : 0;

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
					duration: null,
					waveform: null,
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
					attachments,
					replyTo: replyTo?.id,
				},
			});

			setReplyTo(null);
		},
		[chatId, ws, user, addOptimisticMessage, replyTo],
	);

	const handleEdit = useCallback(
		(content: string) => {
			if (!editingMessage) return;
			ws.send({
				event: "message:edit",
				data: { messageId: editingMessage.id, chatId, content },
			});
			setEditingMessage(null);
		},
		[editingMessage, chatId, ws],
	);

	const handleDelete = useCallback(
		(messageId: string) => {
			ws.send({
				event: "message:delete",
				data: { messageId, chatId },
			});
		},
		[chatId, ws],
	);

	const chatName = chatData?.chat?.name ?? "Chat";
	const memberCount = chatData?.members?.length ?? 0;

	const otherMembers = chatData?.members?.filter((m) => m.userId !== user?.id) ?? [];
	const displayName =
		chatData?.chat?.type === 0 && otherMembers.length > 0
			? (otherMembers[0]?.user?.displayName ?? chatName)
			: chatName;

	const replyToMessage = chatMessages.find((m) => m.id === replyTo?.id);

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
				<div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/20 font-semibold text-primary">
					{displayName.charAt(0).toUpperCase()}
				</div>
				<div>
					<h2 className="font-semibold text-text-primary">{displayName}</h2>
					<p className="text-xs text-text-secondary">
						{typingUserIds.length > 0
							? "typing..."
							: chatData?.chat?.type === 0
								? "private chat"
								: `${memberCount} members`}
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
				<div className="mx-auto max-w-3xl space-y-1">
					{chatMessages.map((msg) => (
						<MessageBubble
							key={msg.id}
							message={msg}
							isOwn={msg.senderId === user?.id}
							isPending={msg.id.startsWith("pending-")}
							onReply={() => setReplyTo(msg)}
							onEdit={() => setEditingMessage(msg)}
							onDelete={() => handleDelete(msg.id)}
							replyToMessage={
								msg.replyTo
									? chatMessages.find((m) => m.id === msg.replyTo) ?? null
									: null
							}
						/>
					))}
				</div>

				{showScrollDown && (
					<button
						type="button"
						onClick={scrollToBottom}
						className="absolute bottom-4 right-4 flex h-10 w-10 items-center justify-center rounded-full bg-surface shadow-lg hover:bg-surface-hover"
						aria-label="Scroll to bottom"
					>
						<ArrowDown size={18} className="text-text-secondary" />
					</button>
				)}
			</div>

			{replyTo && (
				<div className="flex items-center gap-3 border-t border-border bg-surface-secondary px-4 py-2">
					<Reply size={16} className="shrink-0 text-primary" />
					<div className="min-w-0 flex-1">
						<p className="truncate text-xs font-medium text-primary">
							Reply to message
						</p>
						<p className="truncate text-xs text-text-secondary">
							{replyTo.content || "Attachment"}
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
			)}

			<MessageInput
				onSend={editingMessage ? handleEdit : handleSend}
				onTypingStart={onTypingStart}
				onTypingStop={onTypingStop}
				editingMessage={editingMessage}
				onCancelEdit={() => setEditingMessage(null)}
			/>
		</div>
	);
}

const MessageBubble = memo(function MessageBubble({
	message,
	isOwn,
	isPending,
	onReply,
	onEdit,
	onDelete,
	replyToMessage,
}: {
	message: Message;
	isOwn: boolean;
	isPending: boolean;
	onReply: () => void;
	onEdit: () => void;
	onDelete: () => void;
	replyToMessage: Message | null;
}) {
	const [showActions, setShowActions] = useState(false);

	if (message.isDeleted) {
		return (
			<div className={cn("flex", isOwn ? "justify-end" : "justify-start")}>
				<div className="rounded-xl px-3 py-2 text-sm italic text-text-muted">
					Message deleted
				</div>
			</div>
		);
	}

	const images = message.attachments.filter((a) => a.mimeType.startsWith("image/"));
	const files = message.attachments.filter((a) => !a.mimeType.startsWith("image/"));

	return (
		<div
			className={cn("group flex", isOwn ? "justify-end" : "justify-start")}
			onMouseEnter={() => setShowActions(true)}
			onMouseLeave={() => setShowActions(false)}
		>
			<div className="relative max-w-[70%]">
				{showActions && !isPending && (
					<div
						className={cn(
							"absolute -top-8 z-10 flex items-center gap-0.5 rounded-lg bg-surface p-1 shadow-md",
							isOwn ? "right-0" : "left-0",
						)}
					>
						<button
							type="button"
							onClick={onReply}
							className="rounded p-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
							title="Reply"
						>
							<Reply size={14} />
						</button>
						{isOwn && (
							<>
								<button
									type="button"
									onClick={onEdit}
									className="rounded p-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
									title="Edit"
								>
									<Edit2 size={14} />
								</button>
								<button
									type="button"
									onClick={onDelete}
									className="rounded p-1 text-text-secondary hover:bg-danger/10 hover:text-danger"
									title="Delete"
								>
									<Trash2 size={14} />
								</button>
							</>
						)}
					</div>
				)}

				{replyToMessage && (
					<div
						className={cn(
							"mb-1 rounded-lg border-l-2 border-primary/50 bg-black/5 px-3 py-1.5",
						)}
					>
						<p className="truncate text-xs text-text-secondary">
							{replyToMessage.content || "Attachment"}
						</p>
					</div>
				)}

				<div
					className={cn(
						"rounded-2xl px-4 py-2 shadow-sm",
						isOwn
							? "rounded-br-md bg-msg-outgoing"
							: "rounded-bl-md bg-msg-incoming",
						isPending && "opacity-60",
					)}
				>
					{images.length > 0 && (
						<div
							className={cn(
								"mb-1 grid gap-1",
								images.length > 1 ? "grid-cols-2" : "grid-cols-1",
							)}
						>
							{images.map((img, i) => (
								<img
									key={`${img.url}-${i}`}
									src={img.url}
									alt={img.filename ?? "image"}
									className="max-h-60 w-full rounded-lg object-cover"
									loading="lazy"
								/>
							))}
						</div>
					)}
					{files.length > 0 && (
						<div className="mb-1 space-y-1">
							{files.map((f, i) => (
								<a
									key={`${f.url}-${i}`}
									href={f.url}
									target="_blank"
									rel="noopener noreferrer"
									className="flex items-center gap-2 rounded-lg bg-black/5 px-3 py-2 text-xs hover:bg-black/10"
								>
									<span className="truncate font-medium">
										{f.filename ?? "File"}
									</span>
									<span className="shrink-0 text-text-muted">
										{(f.size / 1024).toFixed(0)}KB
									</span>
								</a>
							))}
						</div>
					)}
					{message.content && (
						<p className="whitespace-pre-wrap break-words text-sm text-text-primary">
							{message.content}
						</p>
					)}
					<div className="mt-1 flex items-center justify-end gap-1">
						{message.isEdited && (
							<span className="text-[10px] text-text-muted">edited</span>
						)}
						<span className="text-[10px] text-text-muted">
							{new Date(message.createdAt).toLocaleTimeString([], {
								hour: "2-digit",
								minute: "2-digit",
							})}
						</span>
						{isOwn && !isPending && (
							<CheckCheck size={14} className="text-primary" />
						)}
						{isPending && (
							<span className="text-[10px] text-text-muted">sending</span>
						)}
					</div>
				</div>
			</div>
		</div>
	);
});
