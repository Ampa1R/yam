import { AttachmentType, type Message } from "@yam/shared";
import { Edit2, File, Mic, Paperclip, Send, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { env } from "@/env";
import { useAttachments } from "@/hooks/useAttachments";
import { useVoiceRecording } from "@/hooks/useVoiceRecording";
import { ALLOWED_FILE_TYPES } from "@/lib/file-types";
import { api, eden } from "@/lib/api";
import { cn } from "@/lib/cn";

export interface SendAttachment {
	type: number;
	url: string;
	filename: string;
	size: number;
	mimeType: string;
	duration?: number;
	waveform?: number[];
}

interface Props {
	onSend: (content: string, attachments?: SendAttachment[]) => void;
	onTypingStart: () => void;
	onTypingStop: () => void;
	editingMessage?: Message | null;
	onCancelEdit?: () => void;
}

function mimeToAttachmentType(mime: string): number {
	if (mime.startsWith("image/")) return AttachmentType.IMAGE;
	if (mime.startsWith("video/")) return AttachmentType.VIDEO;
	if (mime.startsWith("audio/")) return AttachmentType.VOICE;
	return AttachmentType.DOCUMENT;
}

export function MessageInput({
	onSend,
	onTypingStart,
	onTypingStop,
	editingMessage,
	onCancelEdit,
}: Props) {
	const [content, setContent] = useState("");
	const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isTyping = useRef(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const uploadFile = useCallback(async (file: File) => {
		return eden(api.api.files.upload.post({ file }));
	}, []);

	const voice = useVoiceRecording({ onSend, uploadFile });
	const files = useAttachments(uploadFile);

	useEffect(() => {
		if (editingMessage) {
			setContent(editingMessage.content);
			textareaRef.current?.focus();
		}
	}, [editingMessage]);

	useEffect(() => {
		const handleVisibilityChange = () => {
			if (document.hidden && isTyping.current) {
				isTyping.current = false;
				onTypingStop();
				if (typingTimeout.current) {
					clearTimeout(typingTimeout.current);
					typingTimeout.current = null;
				}
			}
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => {
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			if (typingTimeout.current) clearTimeout(typingTimeout.current);
			files.revokeAllPreviews();
		};
	}, [onTypingStop, files.revokeAllPreviews]);

	const handleSubmit = useCallback(
		async (e?: React.FormEvent) => {
			e?.preventDefault();
			const trimmed = content.trim();

			if (editingMessage) {
				if (!trimmed) return;
				onSend(trimmed);
				setContent("");
				return;
			}

			const hasAttachments = files.attachments.length > 0;
			if (!trimmed && !hasAttachments) return;

			const failedCount = files.attachments.filter((a) => a.error).length;
			const uploadingCount = files.attachments.filter((a) => a.uploading).length;
			if (uploadingCount > 0) return;
			if (failedCount > 0 && !confirm(`${failedCount} attachment(s) failed to upload and will be skipped. Send anyway?`)) return;

			const uploadedAttachments: SendAttachment[] = [];
			for (const a of files.attachments) {
				if (a.uploadedUrl) {
					uploadedAttachments.push({
						type: mimeToAttachmentType(a.file.type),
						url: a.uploadedUrl,
						filename: a.file.name,
						size: a.file.size,
						mimeType: a.file.type,
					});
				}
			}

			onSend(trimmed || "", uploadedAttachments.length > 0 ? uploadedAttachments : undefined);
			setContent("");
			files.clearAttachments();
			if (isTyping.current) {
				isTyping.current = false;
				onTypingStop();
			}
			if (textareaRef.current) {
				textareaRef.current.style.height = "auto";
			}
		},
		[content, files.attachments, files.clearAttachments, onSend, onTypingStop, editingMessage],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				handleSubmit();
			}
			if (e.key === "Escape" && editingMessage) {
				onCancelEdit?.();
				setContent("");
			}
		},
		[handleSubmit, editingMessage, onCancelEdit],
	);

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const value = e.target.value;
			if (value.length > env.maxMessageLength) return;
			setContent(value);

			if (textareaRef.current) {
				textareaRef.current.style.height = "auto";
				textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
			}

			if (!isTyping.current) {
				isTyping.current = true;
				onTypingStart();
			}

			if (typingTimeout.current) clearTimeout(typingTimeout.current);
			typingTimeout.current = setTimeout(() => {
				isTyping.current = false;
				onTypingStop();
			}, 2000);
		},
		[onTypingStart, onTypingStop],
	);

	const formatDuration = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

	return (
		<div className="border-t border-border bg-surface">
			{voice.recordingError && (
				<div className="mx-4 mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
					{voice.recordingError}
				</div>
			)}
			{files.fileErrors.length > 0 && (
				<div className="mx-4 mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
					{files.fileErrors.map((err, i) => (
						<div key={i}>{err}</div>
					))}
				</div>
			)}
			{editingMessage && (
				<div className="flex items-center gap-3 border-b border-border px-4 py-2">
					<Edit2 size={14} className="shrink-0 text-primary" />
					<div className="min-w-0 flex-1">
						<p className="text-xs font-medium text-primary">Editing message</p>
						<p className="truncate text-xs text-text-secondary">{editingMessage.content}</p>
					</div>
					<button
						type="button"
						onClick={() => {
							onCancelEdit?.();
							setContent("");
						}}
						className="rounded p-1 hover:bg-surface-hover"
						aria-label="Cancel edit"
					>
						<X size={14} className="text-text-muted" />
					</button>
				</div>
			)}

			{files.attachments.length > 0 && (
				<div className="flex gap-2 overflow-x-auto px-4 pt-3">
					{files.attachments.map((a, i) => (
						<div
							key={`${a.file.name}-${a.file.size}-${i}`}
							className={cn(
								"relative shrink-0 rounded-lg border bg-surface-secondary p-1",
								a.error ? "border-danger" : "border-border",
							)}
						>
							{a.preview ? (
								<img
									src={a.preview}
									alt={a.file.name}
									className="h-16 w-16 rounded-md object-cover"
								/>
							) : (
								<div className="flex h-16 w-16 flex-col items-center justify-center rounded-md">
									<File size={20} className="text-text-muted" />
									<span className="mt-1 max-w-[56px] truncate text-[10px] text-text-muted">
										{a.file.name}
									</span>
								</div>
							)}
							{a.uploading && (
								<div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/30">
									<div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
								</div>
							)}
							{a.error && (
								<button
									type="button"
									onClick={() => files.retryUpload(a.file)}
									className="absolute inset-0 flex flex-col items-center justify-center rounded-lg bg-danger/20"
									title="Click to retry"
								>
									<span className="text-[10px] font-medium text-danger">Failed</span>
									<span className="text-[8px] text-danger/70">Retry</span>
								</button>
							)}
							<button
								type="button"
								onClick={() => files.removeAttachment(a.file)}
								className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-danger text-white shadow-sm"
								aria-label={`Remove ${a.file.name}`}
							>
								<X size={12} />
							</button>
						</div>
					))}
				</div>
			)}

			<div className="px-4 py-3">
				<form onSubmit={handleSubmit} className="mx-auto flex max-w-3xl items-end gap-2">
					{!editingMessage && (
						<>
							<input
								ref={fileInputRef}
								type="file"
								multiple
								accept={Array.from(ALLOWED_FILE_TYPES).join(",")}
								className="hidden"
								onChange={(e) => {
									if (e.target.files) files.handleFileSelect(e.target.files);
									e.target.value = "";
								}}
							/>
							<button
								type="button"
								onClick={() => fileInputRef.current?.click()}
								className="mb-1 rounded-full p-2 text-text-secondary hover:bg-surface-hover"
								aria-label="Attach file"
							>
								<Paperclip size={20} />
							</button>
						</>
					)}

				<div className="flex-1">
					{voice.isSendingVoice ? (
						<div className="flex items-center gap-3 rounded-2xl border border-border bg-surface-secondary px-4 py-2.5">
							<div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
							<span className="text-sm text-text-muted">Sending voice message...</span>
						</div>
					) : voice.isRecording ? (
						<div className="flex items-center gap-3 rounded-2xl border border-danger/30 bg-surface-secondary px-4 py-2.5">
							<button
								type="button"
								onClick={() => voice.stopRecording(true)}
								className="shrink-0 rounded-full p-0.5 text-text-muted hover:bg-surface-hover hover:text-danger"
								aria-label="Cancel recording"
								title="Cancel"
							>
								<X size={16} />
							</button>
							<span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" />
							<span className="text-sm font-medium text-text-primary">
								{formatDuration(voice.recordingDuration)}
							</span>
						</div>
					) : (
						<textarea
							ref={textareaRef}
							value={content}
							onChange={handleChange}
							onKeyDown={handleKeyDown}
							placeholder={editingMessage ? "Edit message..." : "Type a message..."}
							rows={1}
							maxLength={env.maxMessageLength}
							className={cn(
								"w-full resize-none rounded-2xl border border-border bg-surface-secondary px-4 py-2.5 text-sm",
								"text-text-primary placeholder:text-text-muted",
								"focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary",
							)}
						/>
					)}
				</div>

				<AnimatePresence mode="wait">
					{voice.isRecording ? (
						<motion.button
							key="record-stop"
							type="button"
							onClick={() => voice.stopRecording()}
							initial={{ scale: 0.8, opacity: 0 }}
							animate={{ scale: 1, opacity: 1 }}
							exit={{ scale: 0.8, opacity: 0 }}
							transition={{ type: "spring", damping: 15 }}
							className="mb-1 rounded-full bg-danger p-2.5 text-white shadow-sm transition-colors hover:bg-danger/80"
							aria-label="Stop and send"
						>
							<Send size={18} />
						</motion.button>
					) : content.trim() || files.attachments.length > 0 || editingMessage ? (
						<motion.button
							key="send"
							type="submit"
							disabled={
								(!editingMessage && files.attachments.some((a) => a.uploading)) ||
								(!content.trim() && files.attachments.length === 0)
							}
							initial={{ scale: 0.8, opacity: 0 }}
							animate={{ scale: 1, opacity: 1 }}
							exit={{ scale: 0.8, opacity: 0 }}
							transition={{ type: "spring", damping: 15 }}
							className={cn(
								"mb-1 rounded-full bg-primary p-2.5 text-white shadow-sm transition-colors hover:bg-primary-hover",
								"disabled:opacity-50",
							)}
							aria-label={editingMessage ? "Save edit" : "Send message"}
						>
							{editingMessage ? <Edit2 size={18} /> : <Send size={18} />}
						</motion.button>
					) : (
						<motion.button
							key="mic"
							type="button"
							onClick={voice.startRecording}
							initial={{ scale: 0.8, opacity: 0 }}
							animate={{ scale: 1, opacity: 1 }}
							exit={{ scale: 0.8, opacity: 0 }}
							transition={{ type: "spring", damping: 15 }}
							className="mb-1 rounded-full p-2.5 text-text-secondary hover:bg-surface-hover"
							aria-label="Voice message"
						>
							<Mic size={20} />
						</motion.button>
					)}
				</AnimatePresence>
				</form>
			</div>
		</div>
	);
}
