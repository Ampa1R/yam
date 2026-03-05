import { AttachmentType } from "@yam/shared";
import { File, Mic, Paperclip, Send, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";

interface AttachmentItem {
	file: File;
	preview?: string;
	uploading: boolean;
	uploadedUrl?: string;
	uploadedId?: string;
}

interface Props {
	onSend: (
		content: string,
		attachments?: { type: number; url: string; filename: string; size: number; mimeType: string }[],
	) => void;
	onTypingStart: () => void;
	onTypingStop: () => void;
}

function mimeToAttachmentType(mime: string): number {
	if (mime.startsWith("image/")) return AttachmentType.IMAGE;
	if (mime.startsWith("video/")) return AttachmentType.VIDEO;
	if (mime.startsWith("audio/")) return AttachmentType.VOICE;
	return AttachmentType.DOCUMENT;
}

export function MessageInput({ onSend, onTypingStart, onTypingStop }: Props) {
	const [content, setContent] = useState("");
	const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
	const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isTyping = useRef(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const previewUrlsRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		return () => {
			if (typingTimeout.current) clearTimeout(typingTimeout.current);
			for (const url of previewUrlsRef.current) {
				URL.revokeObjectURL(url);
			}
			previewUrlsRef.current.clear();
		};
	}, []);

	const handleSubmit = useCallback(
		async (e?: React.FormEvent) => {
			e?.preventDefault();
			const trimmed = content.trim();
			const hasAttachments = attachments.length > 0;
			if (!trimmed && !hasAttachments) return;

			const uploadedAttachments = attachments
				.filter((a) => a.uploadedUrl)
				.map((a) => ({
					type: mimeToAttachmentType(a.file.type),
					url: a.uploadedUrl!,
					filename: a.file.name,
					size: a.file.size,
					mimeType: a.file.type,
				}));

			onSend(trimmed || "", uploadedAttachments.length > 0 ? uploadedAttachments : undefined);
			setContent("");
			setAttachments([]);
			if (isTyping.current) {
				isTyping.current = false;
				onTypingStop();
			}
			if (textareaRef.current) {
				textareaRef.current.style.height = "auto";
			}
		},
		[content, attachments, onSend, onTypingStop],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				handleSubmit();
			}
		},
		[handleSubmit],
	);

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			setContent(e.target.value);

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

	const handleFileSelect = useCallback(async (files: FileList) => {
		const newAttachments: AttachmentItem[] = Array.from(files).map((file) => {
			let preview: string | undefined;
			if (file.type.startsWith("image/")) {
				preview = URL.createObjectURL(file);
				previewUrlsRef.current.add(preview);
			}
			return { file, preview, uploading: true };
		});

		setAttachments((prev) => [...prev, ...newAttachments]);

		for (const attachment of newAttachments) {
			try {
				const result = await api.upload<{ id: string; url: string }>(
					"/files/upload",
					attachment.file,
				);
				setAttachments((prev) =>
					prev.map((a) =>
						a.file === attachment.file
							? { ...a, uploading: false, uploadedUrl: result.url, uploadedId: result.id }
							: a,
					),
				);
			} catch {
				setAttachments((prev) => {
					const removed = prev.find((a) => a.file === attachment.file);
					if (removed?.preview) {
						URL.revokeObjectURL(removed.preview);
						previewUrlsRef.current.delete(removed.preview);
					}
					return prev.filter((a) => a.file !== attachment.file);
				});
			}
		}
	}, []);

	const removeAttachment = useCallback((file: File) => {
		setAttachments((prev) => {
			const removed = prev.find((a) => a.file === file);
			if (removed?.preview) {
				URL.revokeObjectURL(removed.preview);
				previewUrlsRef.current.delete(removed.preview);
			}
			return prev.filter((a) => a.file !== file);
		});
	}, []);

	return (
		<div className="border-t border-border bg-surface">
			{attachments.length > 0 && (
				<div className="flex gap-2 overflow-x-auto px-4 pt-3">
					{attachments.map((a, i) => (
						<div
							key={`${a.file.name}-${i}`}
							className="relative shrink-0 rounded-lg border border-border bg-surface-secondary p-1"
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
							<button
								type="button"
								onClick={() => removeAttachment(a.file)}
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
					<input
						ref={fileInputRef}
						type="file"
						multiple
						className="hidden"
						onChange={(e) => {
							if (e.target.files) handleFileSelect(e.target.files);
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

					<div className="flex-1">
						<textarea
							ref={textareaRef}
							value={content}
							onChange={handleChange}
							onKeyDown={handleKeyDown}
							placeholder="Type a message..."
							rows={1}
							className={cn(
								"w-full resize-none rounded-2xl border border-border bg-surface-secondary px-4 py-2.5 text-sm",
								"text-text-primary placeholder:text-text-muted",
								"focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary",
							)}
						/>
					</div>

					{content.trim() || attachments.length > 0 ? (
						<button
							type="submit"
							disabled={attachments.some((a) => a.uploading)}
							className={cn(
								"mb-1 rounded-full bg-primary p-2.5 text-white shadow-sm transition-colors hover:bg-primary-hover",
								"disabled:opacity-50",
							)}
							aria-label="Send message"
						>
							<Send size={18} />
						</button>
					) : (
						<button
							type="button"
							className="mb-1 rounded-full p-2.5 text-text-secondary hover:bg-surface-hover"
							aria-label="Voice message"
						>
							<Mic size={20} />
						</button>
					)}
				</form>
			</div>
		</div>
	);
}
