import { AttachmentType } from "@yam/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SendAttachment } from "@/features/chat/MessageInput";

const MAX_VOICE_DURATION = 300;
const WAVEFORM_SAMPLES = 50;

interface UseVoiceRecordingParams {
	onSend: (content: string, attachments?: SendAttachment[]) => void;
	uploadFile: (file: File) => Promise<unknown>;
}

export function useVoiceRecording({ onSend, uploadFile }: UseVoiceRecordingParams) {
	const [isRecording, setIsRecording] = useState(false);
	const [isSendingVoice, setIsSendingVoice] = useState(false);
	const [recordingDuration, setRecordingDuration] = useState(0);
	const [recordingError, setRecordingError] = useState<string | null>(null);

	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const audioChunksRef = useRef<Blob[]>([]);
	const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const recordingStartRef = useRef<number>(0);
	const recordingStopRef = useRef<number>(0);

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
				waveform.push(sum / (end - start));
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
			for (const t of mediaRecorderRef.current?.stream.getTracks() ?? []) t.stop();
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
				for (const t of stream.getTracks()) t.stop();
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
				for (const t of mediaRecorderRef.current.stream.getTracks()) t.stop();
				mediaRecorderRef.current.stop();
			}
			if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
		};
	}, []);

	return {
		isRecording,
		isSendingVoice,
		recordingDuration,
		recordingError,
		startRecording,
		stopRecording,
	};
}
