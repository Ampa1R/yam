import { AttachmentType, type Message } from "@yam/shared";
import { Edit2, File, Mic, Paperclip, Send, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { env } from "@/env";
import { ALLOWED_FILE_TYPES } from "@/lib/file-types";
import { api, eden } from "@/lib/api";
import { cn } from "@/lib/cn";

interface AttachmentItem {
	file: File;
	preview?: string;
	uploading: boolean;
	uploadedUrl?: string;
	uploadedId?: string;
	error?: string;
}

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

const MAX_FILE_SIZE = env.maxFileSizeMb * 1024 * 1024;

export function MessageInput({
	onSend,
	onTypingStart,
	onTypingStop,
	editingMessage,
	onCancelEdit,
}: Props) {
	const [content, setContent] = useState("");
	const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
	const [fileErrors, setFileErrors] = useState<string[]>([]);
	const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isTyping = useRef(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const previewUrlsRef = useRef<Set<string>>(new Set());

	const uploadFile = useCallback(async (file: File) => {
		return eden(api.api.files.upload.post({ file }));
	}, []);

	const [isRecording, setIsRecording] = useState(false);
	const [isSendingVoice, setIsSendingVoice] = useState(false);
	const [recordingDuration, setRecordingDuration] = useState(0);
	const [recordingError, setRecordingError] = useState<string | null>(null);
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const audioChunksRef = useRef<Blob[]>([]);
	const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const recordingStartRef = useRef<number>(0);
	const recordingStopRef = useRef<number>(0);

	const MAX_VOICE_DURATION = 300;
	const WAVEFORM_SAMPLES = 50;

	const generateWaveform = useCallback(async (blob: Blob): Promise<number[]> => {
		let audioContext: AudioContext | null = null;
		try {
			audioContext = new AudioContext();
			const arrayBuffer = await blob.arrayBuffer();
			const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
			const channelData = audioBuffer.getChannelData(0);

			const samplesPerBar = Math.max(1, Math.floor(channelData.length / WAVEFORM_SAMPLES));
			const waveform: number[] = [];

			for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
				const start = i * samplesPerBar;
				const end = Math.min(start + samplesPerBar, channelData.length);
				let sum = 0;
				for (let j = start; j < end; j++) {
					sum += Math.abs(channelData[j]!);
				}
				const rms = sum / (end - start);
				waveform.push(rms);
			}

			const max = Math.max(...waveform, 0.001);
			return waveform.map((v) => Math.round((v / max) * 100));
		} catch {
			return Array.from({ length: WAVEFORM_SAMPLES }, (_, i) => {
				const x = Math.sin(i * 0.7) * 0.5 + Math.cos(i * 1.3) * 0.3 + 0.5;
				return Math.round(15 + x * 60);
			});
		} finally {
			if (audioContext) await audioContext.close().catch(() => {});
		}
	}, []);

	const stopRecording = useCallback((discard = false) => {
		recordingStopRef.current = Date.now();
		if (discard && mediaRecorderRef.current) {
			mediaRecorderRef.current.ondataavailable = null;
			mediaRecorderRef.current.onstop = () => {
				mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop());
			};
		}
		if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
			mediaRecorderRef.current.stop();
		}
		if (recordingTimerRef.current) {
			clearInterval(recordingTimerRef.current);
			recordingTimerRef.current = null;
		}
		setIsRecording(false);
		setRecordingDuration(0);
	}, []);

	const startRecording = useCallback(async () => {
		try {
			setRecordingError(null);
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

			const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
				? "audio/webm;codecs=opus"
				: MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
					? "audio/ogg;codecs=opus"
					: "audio/webm";

			const recorder = new MediaRecorder(stream, { mimeType });
			mediaRecorderRef.current = recorder;
			audioChunksRef.current = [];

			recorder.ondataavailable = (e) => {
				if (e.data.size > 0) audioChunksRef.current.push(e.data);
			};

			recorder.onstop = async () => {
				stream.getTracks().forEach((t) => t.stop());
				const blob = new Blob(audioChunksRef.current, { type: mimeType });
				if (blob.size < 1000) {
					setIsSendingVoice(false);
					return;
				}

				setIsSendingVoice(true);
				const ext = mimeType.includes("ogg") ? "ogg" : "webm";
				const file = new globalThis.File([blob], `voice-message.${ext}`, { type: mimeType.split(";")[0] });

				try {
					const [result, waveform] = await Promise.all([
						uploadFile(file),
						generateWaveform(blob),
					]);
					const uploaded = result as { url: string; id: string };
					const stopTime = recordingStopRef.current || Date.now();
					const durationSec = Math.max(1, Math.round((stopTime - recordingStartRef.current) / 1000));
					onSend("", [
						{
							type: AttachmentType.VOICE,
							url: uploaded.url,
							filename: file.name,
							size: file.size,
							mimeType: file.type,
							duration: durationSec,
							waveform,
						},
					]);
				} catch {
					setRecordingError("Failed to upload voice message");
					setTimeout(() => setRecordingError(null), 4000);
				} finally {
					setIsSendingVoice(false);
				}
			};

			recorder.start(250);
			recordingStartRef.current = Date.now();
			setIsRecording(true);
			setRecordingDuration(0);

			recordingTimerRef.current = setInterval(() => {
				const elapsed = Math.floor((Date.now() - recordingStartRef.current) / 1000);
				setRecordingDuration(elapsed);
				if (elapsed >= MAX_VOICE_DURATION) {
					stopRecording();
				}
			}, 500);
		} catch {
			setRecordingError("Microphone access denied");
			setTimeout(() => setRecordingError(null), 4000);
		}
	}, [onSend, stopRecording, generateWaveform, uploadFile]);

	useEffect(() => {
		return () => {
			if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
				mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
				mediaRecorderRef.current.stop();
			}
			if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
		};
	}, []);

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
			for (const url of previewUrlsRef.current) {
				URL.revokeObjectURL(url);
			}
			previewUrlsRef.current.clear();
		};
	}, [onTypingStop]);

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

			const hasAttachments = attachments.length > 0;
			if (!trimmed && !hasAttachments) return;

			const failedCount = attachments.filter((a) => a.error).length;
			const uploadingCount = attachments.filter((a) => a.uploading).length;
			if (uploadingCount > 0) return;
			if (failedCount > 0 && !confirm(`${failedCount} attachment(s) failed to upload and will be skipped. Send anyway?`)) return;

			const uploadedAttachments: SendAttachment[] = [];
			for (const a of attachments) {
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
			setAttachments([]);
			if (isTyping.current) {
				isTyping.current = false;
				onTypingStop();
			}
			if (textareaRef.current) {
				textareaRef.current.style.height = "auto";
			}
		},
		[content, attachments, onSend, onTypingStop, editingMessage],
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

	const validateFile = useCallback((file: File): string | null => {
		if (file.size > MAX_FILE_SIZE) {
			return `File "${file.name}" exceeds ${env.maxFileSizeMb}MB limit`;
		}
		if (!ALLOWED_FILE_TYPES.has(file.type) && file.type !== "") {
			return `File type "${file.type}" is not allowed`;
		}
		return null;
	}, []);

	const handleFileSelect = useCallback(
		async (files: FileList) => {
			const validFiles: { file: File; preview?: string }[] = [];
			const errors: string[] = [];

			for (const file of Array.from(files)) {
				const error = validateFile(file);
				if (error) {
					errors.push(error);
					continue;
				}
				let preview: string | undefined;
				if (file.type.startsWith("image/")) {
					preview = URL.createObjectURL(file);
					previewUrlsRef.current.add(preview);
				}
				validFiles.push({ file, preview });
			}

		if (errors.length > 0) {
			setFileErrors(errors);
			setTimeout(() => setFileErrors([]), 5000);
		}

			if (validFiles.length === 0) return;

			const newAttachments: AttachmentItem[] = validFiles.map((v) => ({
				file: v.file,
				preview: v.preview,
				uploading: true,
			}));

			setAttachments((prev) => [...prev, ...newAttachments]);

			for (const attachment of newAttachments) {
				try {
					const result = await uploadFile(attachment.file);
					setAttachments((prev) =>
						prev.map((a) =>
							a.file === attachment.file
								? {
										...a,
										uploading: false,
										uploadedUrl: (result as { url: string; id: string }).url,
										uploadedId: (result as { url: string; id: string }).id,
									}
								: a,
						),
					);
				} catch (err) {
					setAttachments((prev) =>
						prev.map((a) =>
							a.file === attachment.file
								? {
										...a,
										uploading: false,
										error: err instanceof Error ? err.message : "Upload failed",
									}
								: a,
						),
					);
				}
			}
		},
		[validateFile, uploadFile],
	);

	const retryUpload = useCallback(
		async (file: File) => {
			setAttachments((prev) =>
				prev.map((a) => (a.file === file ? { ...a, uploading: true, error: undefined } : a)),
			);
			try {
				const result = (await uploadFile(file)) as { url: string; id: string };
				setAttachments((prev) =>
					prev.map((a) =>
						a.file === file
							? { ...a, uploading: false, uploadedUrl: result.url, uploadedId: result.id }
							: a,
					),
				);
			} catch (err) {
				setAttachments((prev) =>
					prev.map((a) =>
						a.file === file
							? {
									...a,
									uploading: false,
									error: err instanceof Error ? err.message : "Upload failed",
								}
							: a,
					),
				);
			}
		},
		[uploadFile],
	);

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

	const formatDuration = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

	return (
		<div className="border-t border-border bg-surface">
			{recordingError && (
				<div className="mx-4 mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
					{recordingError}
				</div>
			)}
			{fileErrors.length > 0 && (
				<div className="mx-4 mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
					{fileErrors.map((err, i) => (
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

			{attachments.length > 0 && (
				<div className="flex gap-2 overflow-x-auto px-4 pt-3">
					{attachments.map((a, i) => (
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
									onClick={() => retryUpload(a.file)}
									className="absolute inset-0 flex flex-col items-center justify-center rounded-lg bg-danger/20"
									title="Click to retry"
								>
									<span className="text-[10px] font-medium text-danger">Failed</span>
									<span className="text-[8px] text-danger/70">Retry</span>
								</button>
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
					{!editingMessage && (
						<>
							<input
								ref={fileInputRef}
								type="file"
								multiple
								accept={Array.from(ALLOWED_FILE_TYPES).join(",")}
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
						</>
					)}

				<div className="flex-1">
					{isSendingVoice ? (
						<div className="flex items-center gap-3 rounded-2xl border border-border bg-surface-secondary px-4 py-2.5">
							<div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
							<span className="text-sm text-text-muted">Sending voice message...</span>
						</div>
					) : isRecording ? (
						<div className="flex items-center gap-3 rounded-2xl border border-danger/30 bg-surface-secondary px-4 py-2.5">
							<button
								type="button"
								onClick={() => stopRecording(true)}
								className="shrink-0 rounded-full p-0.5 text-text-muted hover:bg-surface-hover hover:text-danger"
								aria-label="Cancel recording"
								title="Cancel"
							>
								<X size={16} />
							</button>
							<span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" />
							<span className="text-sm font-medium text-text-primary">
								{formatDuration(recordingDuration)}
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
					{isRecording ? (
						<motion.button
							key="record-stop"
							type="button"
							onClick={() => stopRecording()}
							initial={{ scale: 0.8, opacity: 0 }}
							animate={{ scale: 1, opacity: 1 }}
							exit={{ scale: 0.8, opacity: 0 }}
							transition={{ type: "spring", damping: 15 }}
							className="mb-1 rounded-full bg-danger p-2.5 text-white shadow-sm transition-colors hover:bg-danger/80"
							aria-label="Stop and send"
						>
							<Send size={18} />
						</motion.button>
					) : content.trim() || attachments.length > 0 || editingMessage ? (
						<motion.button
							key="send"
							type="submit"
							disabled={
								(!editingMessage && attachments.some((a) => a.uploading)) ||
								(!content.trim() && attachments.length === 0)
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
							onClick={startRecording}
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
