import { useQuery } from "@tanstack/react-query";
import type { Attachment, AttachmentType, ClientEvent, Message } from "@yam/shared";
import { ArrowLeft, CheckCheck, Loader2 } from "lucide-react";
import React, { memo, useCallback, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";
import { MessageInput } from "./MessageInput";

interface Props {
	chatId: string;
	ws: { send: (event: ClientEvent) => void };
}

export function ChatView({ chatId, ws }: Props) {
	const { messages, setMessages, addOptimisticMessage, typingUsers, setActiveChatId } =
		useChatStore();
	const { user } = useAuthStore();
	const scrollRef = useRef<HTMLDivElement>(null);
	const lastReadRef = useRef<string | null>(null);
	const chatMessages = messages.get(chatId) ?? [];
	const chatTyping = typingUsers.get(chatId);

	const {
		data: chatData,
		isLoading: chatLoading,
	} = useQuery({
		queryKey: ["chat", chatId],
		queryFn: () => api.get<{ chat: any; members: any[]; myMembership: any }>(`/chats/${chatId}`),
	});

	const {
		data: messagesData,
		isLoading: messagesLoading,
	} = useQuery({
		queryKey: ["messages", chatId],
		queryFn: () =>
			api.get<{ messages: Message[]; nextCursor: string | null }>(
				`/chats/${chatId}/messages?limit=50`,
			),
	});

	useEffect(() => {
		if (messagesData?.messages) {
			setMessages(chatId, [...messagesData.messages].reverse());
		}
	}, [messagesData, chatId, setMessages]);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		el.scrollTo({ top: el.scrollHeight, behavior: chatMessages.length > 1 ? "smooth" : "auto" });
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
				replyTo: null,
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
				},
			});
		},
		[chatId, ws, user, addOptimisticMessage],
	);

	const chatName = chatData?.chat?.name ?? "Chat";
	const memberCount = chatData?.members?.length ?? 0;

	const otherMembers = chatData?.members?.filter((m: any) => m.userId !== user?.id) ?? [];
	const displayName =
		chatData?.chat?.type === 0 && otherMembers.length > 0
			? (otherMembers[0]?.user?.displayName ?? chatName)
			: chatName;

	return (
		<div className="flex h-full flex-col bg-chat-bg">
			<header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3">
				<button
					onClick={() => setActiveChatId(null)}
					className="rounded-lg p-1 text-text-secondary hover:bg-surface-hover lg:hidden"
					aria-label="Back to chats"
				>
					<ArrowLeft size={20} />
				</button>
				<div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/20 text-primary font-semibold">
					{displayName.charAt(0).toUpperCase()}
				</div>
				<div>
					<h2 className="font-semibold text-text-primary">{displayName}</h2>
					<p className="text-xs text-text-secondary">
						{chatTyping && chatTyping.size > 0
							? "typing..."
							: chatData?.chat?.type === 0
								? "private chat"
								: `${memberCount} members`}
					</p>
				</div>
			</header>

			<div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
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
						/>
					))}
				</div>
			</div>

			<MessageInput
				onSend={handleSend}
				onTypingStart={onTypingStart}
				onTypingStop={onTypingStop}
			/>
		</div>
	);
}

const MessageBubble = memo(function MessageBubble({
	message,
	isOwn,
	isPending,
}: {
	message: Message;
	isOwn: boolean;
	isPending: boolean;
}) {
	if (message.isDeleted) {
		return (
			<div className={cn("flex", isOwn ? "justify-end" : "justify-start")}>
				<div className="rounded-xl px-3 py-2 text-sm italic text-text-muted">Message deleted</div>
			</div>
		);
	}

	const images = message.attachments.filter((a) => a.mimeType.startsWith("image/"));
	const files = message.attachments.filter((a) => !a.mimeType.startsWith("image/"));

	return (
		<div className={cn("flex", isOwn ? "justify-end" : "justify-start")}>
			<div
				className={cn(
					"max-w-[70%] rounded-2xl px-4 py-2 shadow-sm",
					isOwn ? "rounded-br-md bg-msg-outgoing" : "rounded-bl-md bg-msg-incoming",
					isPending && "opacity-60",
				)}
			>
				{images.length > 0 && (
					<div className={cn("mb-1 grid gap-1", images.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
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
								<span className="truncate font-medium">{f.filename ?? "File"}</span>
								<span className="shrink-0 text-text-muted">{(f.size / 1024).toFixed(0)}KB</span>
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
					{message.isEdited && <span className="text-[10px] text-text-muted">edited</span>}
					<span className="text-[10px] text-text-muted">
						{new Date(message.createdAt).toLocaleTimeString([], {
							hour: "2-digit",
							minute: "2-digit",
						})}
					</span>
					{isOwn && !isPending && <CheckCheck size={14} className="text-primary" />}
					{isPending && <span className="text-[10px] text-text-muted">sending</span>}
				</div>
			</div>
		</div>
	);
});
