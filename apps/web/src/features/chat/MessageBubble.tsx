import type { Message } from "@yam/shared";
import { AttachmentType as AttachmentTypeEnum, MessageStatus, MessageType } from "@yam/shared";
import {
	Check,
	CheckCheck,
	Edit2,
	Reply,
	Trash2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useState } from "react";
import { cn } from "@/lib/cn";
import { useChatStore } from "@/stores/chat";
import { VoicePlayer } from "./VoicePlayer";

const SWIPE_THRESHOLD = 60;

function categorizeAttachments(attachments: Message["attachments"]) {
	const voice = attachments.filter((a) => a.type === AttachmentTypeEnum.VOICE || a.mimeType.startsWith("audio/"));
	const images = attachments.filter((a) => a.mimeType.startsWith("image/"));
	const files = attachments.filter((a) => !a.mimeType.startsWith("image/") && !a.mimeType.startsWith("audio/") && a.type !== AttachmentTypeEnum.VOICE);
	return { voice, images, files };
}

function getReplyPreview(msg: Message): string {
	if (msg.isDeleted) return "Message deleted";
	if (msg.content) return msg.content;
	if (msg.type === MessageType.VOICE) return "🎤 Voice message";
	return "Attachment";
}

function DeliveryStatusIcon({ status }: { status: number }) {
	if (status === MessageStatus.READ) return <CheckCheck size={14} className="text-primary" />;
	if (status === MessageStatus.DELIVERED) return <CheckCheck size={14} className="text-text-muted" />;
	return <Check size={14} className="text-text-muted" />;
}

export const MessageBubble = memo(function MessageBubble({
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
	onReply: (msg: Message) => void;
	onEdit: (msg: Message) => void;
	onDelete: (messageId: string) => void;
	replyToMessage: Message | null;
}) {
	const deliveryStatus = useChatStore(
		(s) => s.messageStatuses.get(message.id) ?? MessageStatus.SENT,
	);
	const [showActions, setShowActions] = useState(false);
	const [dragX, setDragX] = useState(0);

	if (message.isDeleted) {
		return (
			<div className={cn("flex", isOwn ? "justify-end" : "justify-start")}>
				<div className="rounded-xl px-3 py-2 text-sm italic text-text-muted">Message deleted</div>
			</div>
		);
	}

	const { voice: voiceAttachments, images, files } = categorizeAttachments(message.attachments);
	const primaryVoice = voiceAttachments[0];
	const isVoiceMessage = primaryVoice != null && !message.content && images.length === 0 && files.length === 0;

	return (
		<div
			className={cn("group flex", isOwn ? "justify-end" : "justify-start")}
			onMouseEnter={() => setShowActions(true)}
			onMouseLeave={() => setShowActions(false)}
		>
			{!isOwn && (
				<div className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2" style={{ opacity: Math.min(1, Math.abs(dragX) / SWIPE_THRESHOLD) }}>
					<Reply size={16} className="text-primary" />
				</div>
			)}
			{isOwn && (
				<div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2" style={{ opacity: Math.min(1, Math.abs(dragX) / SWIPE_THRESHOLD) }}>
					{dragX < 0 ? <Trash2 size={16} className="text-danger" /> : <Reply size={16} className="text-primary" />}
				</div>
			)}
			<motion.div
				drag={isPending ? false : "x"}
				dragConstraints={{ left: isOwn ? -80 : 0, right: 80 }}
				dragElastic={0.2}
				dragSnapToOrigin
				onDrag={(_, info) => setDragX(info.offset.x)}
				onDragEnd={(_, info) => {
					setDragX(0);
					if (info.offset.x > SWIPE_THRESHOLD) onReply(message);
					else if (info.offset.x < -SWIPE_THRESHOLD && isOwn) onDelete(message.id);
				}}
				className="relative max-w-[70%]"
			>
				{showActions && !isPending && (
					<div
						className={cn(
							"absolute -top-8 z-10 flex items-center gap-0.5 rounded-lg bg-surface p-1 shadow-md",
							"before:absolute before:left-0 before:top-full before:h-2 before:w-full before:content-['']",
							isOwn ? "right-0" : "left-0",
						)}
					>
						<button
							type="button"
							onClick={() => onReply(message)}
							className="rounded p-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
							title="Reply"
						>
							<Reply size={14} />
						</button>
						{isOwn && (
							<>
								{!isVoiceMessage && (
									<button
										type="button"
										onClick={() => onEdit(message)}
										className="rounded p-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
										title="Edit"
									>
										<Edit2 size={14} />
									</button>
								)}
								<button
									type="button"
									onClick={() => onDelete(message.id)}
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
					<div className={cn("mb-1 rounded-lg border-l-2 border-primary/50 bg-black/5 px-3 py-1.5")}>
						<p className="truncate text-xs text-text-secondary italic">
							{getReplyPreview(replyToMessage)}
						</p>
					</div>
				)}

				<div
					className={cn(
						"rounded-2xl px-4 py-2 shadow-sm",
						isOwn ? "rounded-br-md bg-msg-outgoing" : "rounded-bl-md bg-msg-incoming",
						isPending && "opacity-60",
					)}
				>
					{isVoiceMessage ? (
					<VoicePlayer
						src={primaryVoice.url}
						duration={primaryVoice.duration}
						waveform={primaryVoice.waveform}
						isOwn={isOwn}
					/>
					) : (
						<>
							{images.length > 0 && (
								<div
									className={cn("mb-1 grid gap-1", images.length > 1 ? "grid-cols-2" : "grid-cols-1")}
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
											<span className="truncate font-medium">{f.filename ?? "File"}</span>
											<span className="shrink-0 text-text-muted">{(f.size / 1024).toFixed(0)}KB</span>
										</a>
									))}
								</div>
							)}
							{message.content && (
								<p className="whitespace-pre-wrap wrap-break-word text-sm text-text-primary">
									{message.content}
								</p>
							)}
						</>
					)}
					<div className="mt-1 flex items-center justify-end gap-1">
						{message.isEdited && <span className="text-[10px] text-text-muted">edited</span>}
						<span className="text-[10px] text-text-muted">
							{new Date(message.createdAt).toLocaleTimeString([], {
								hour: "2-digit",
								minute: "2-digit",
							})}
						</span>
						{isOwn && !isPending && (
							<AnimatePresence mode="wait">
								<motion.span
									key={deliveryStatus}
									initial={{ scale: 0.5, opacity: 0 }}
									animate={{ scale: 1, opacity: 1 }}
									exit={{ scale: 0.5, opacity: 0 }}
									transition={{ type: "spring", damping: 12 }}
									className="inline-flex"
								>
									<DeliveryStatusIcon status={deliveryStatus} />
								</motion.span>
							</AnimatePresence>
						)}
						{isPending && <span className="text-[10px] text-text-muted">sending</span>}
					</div>
				</div>
			</motion.div>
		</div>
	);
});
