import { Pause, Play } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

interface Props {
	src: string;
	duration: number | null;
	waveform: number[] | null;
	isOwn: boolean;
}

const stopAllEvent = new EventTarget();

function stopOtherPlayers(except: string) {
	stopAllEvent.dispatchEvent(new CustomEvent("stop", { detail: except }));
}

const BARS = 40;

function normalizeWaveform(raw: number[] | null): number[] {
	if (!raw || raw.length === 0) {
		return Array.from({ length: BARS }, (_, i) => {
			const x = Math.sin(i * 0.7) * 0.5 + Math.cos(i * 1.3) * 0.3 + 0.5;
			return 15 + x * 35;
		});
	}

	const result: number[] = [];
	const step = raw.length / BARS;
	for (let i = 0; i < BARS; i++) {
		const idx = Math.min(Math.floor(i * step), raw.length - 1);
		result.push(Math.max(5, raw[idx] ?? 5));
	}

	const max = Math.max(...result, 1);
	return result.map((v) => Math.max(5, (v / max) * 100));
}

function formatTime(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${String(s).padStart(2, "0")}`;
}

export const VoicePlayer = memo(function VoicePlayer({ src, duration, waveform, isOwn }: Props) {
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [currentTime, setCurrentTime] = useState(0);
	const [totalDuration, setTotalDuration] = useState(duration ?? 0);
	const bars = useRef(normalizeWaveform(waveform));
	const animFrameRef = useRef<number>(0);
	const instanceId = useRef(crypto.randomUUID());

	useEffect(() => {
		bars.current = normalizeWaveform(waveform);
	}, [waveform]);

	const getAudio = useCallback(() => {
		if (!audioRef.current) {
			const audio = new Audio(src);
			audio.preload = "metadata";

			audio.addEventListener("loadedmetadata", () => {
				if (Number.isFinite(audio.duration)) {
					setTotalDuration(audio.duration);
				}
			});

			audio.addEventListener("ended", () => {
				setIsPlaying(false);
				setCurrentTime(0);
				cancelAnimationFrame(animFrameRef.current);
			});

			audioRef.current = audio;
		}
		return audioRef.current;
	}, [src]);

	useEffect(() => {
		const handler = (e: Event) => {
			const id = (e as CustomEvent).detail;
			if (id !== instanceId.current && audioRef.current && !audioRef.current.paused) {
				audioRef.current.pause();
				setIsPlaying(false);
				cancelAnimationFrame(animFrameRef.current);
			}
		};
		stopAllEvent.addEventListener("stop", handler);
		return () => {
			stopAllEvent.removeEventListener("stop", handler);
			if (audioRef.current) {
				audioRef.current.pause();
				audioRef.current.src = "";
				audioRef.current = null;
			}
			cancelAnimationFrame(animFrameRef.current);
		};
	}, []);

	const tick = useCallback(() => {
		const audio = audioRef.current;
		if (audio && !audio.paused) {
			setCurrentTime(audio.currentTime);
			animFrameRef.current = requestAnimationFrame(tick);
		}
	}, []);

	const togglePlay = useCallback(() => {
		const audio = getAudio();
		if (audio.paused) {
			stopOtherPlayers(instanceId.current);
			audio.play().then(() => {
				setIsPlaying(true);
				animFrameRef.current = requestAnimationFrame(tick);
			}).catch(() => {
				setIsPlaying(false);
			});
		} else {
			audio.pause();
			setIsPlaying(false);
			cancelAnimationFrame(animFrameRef.current);
		}
	}, [getAudio, tick]);

	const handleBarClick = useCallback(
		(e: React.MouseEvent<HTMLDivElement>) => {
			const audio = getAudio();
			const rect = e.currentTarget.getBoundingClientRect();
			const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
			const dur = totalDuration || audio.duration || 0;
			if (dur > 0) {
				audio.currentTime = ratio * dur;
				setCurrentTime(audio.currentTime);
			}
		},
		[getAudio, totalDuration],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			const audio = getAudio();
			const dur = totalDuration || audio.duration || 0;
			if (dur <= 0) return;
			const step = dur * 0.05;
			if (e.key === "ArrowRight") {
				audio.currentTime = Math.min(dur, audio.currentTime + step);
				setCurrentTime(audio.currentTime);
			} else if (e.key === "ArrowLeft") {
				audio.currentTime = Math.max(0, audio.currentTime - step);
				setCurrentTime(audio.currentTime);
			} else if (e.key === " " || e.key === "Enter") {
				e.preventDefault();
				togglePlay();
			}
		},
		[getAudio, totalDuration, togglePlay],
	);

	const progress = totalDuration > 0 ? currentTime / totalDuration : 0;
	const activeBar = Math.floor(progress * BARS);

	return (
		<div className="flex items-center gap-2.5 py-1" style={{ minWidth: 220 }}>
			<button
				type="button"
				onClick={togglePlay}
				className={cn(
					"flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors",
					isOwn
						? "bg-white/20 text-white hover:bg-white/30"
						: "bg-primary/10 text-primary hover:bg-primary/20",
				)}
			>
				{isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
			</button>

			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div
					className="flex h-7 cursor-pointer items-end gap-px"
					onClick={handleBarClick}
					onKeyDown={handleKeyDown}
					role="slider"
					aria-valuenow={Math.round(currentTime)}
					aria-valuemax={Math.round(totalDuration)}
					aria-label="Voice message progress"
					tabIndex={0}
				>
					{bars.current.map((height, i) => (
						<div
							key={i}
							className={cn(
								"flex-1 rounded-sm transition-colors duration-75",
								i <= activeBar
									? isOwn ? "bg-white" : "bg-primary"
									: isOwn ? "bg-white/30" : "bg-primary/25",
							)}
							style={{
								height: `${Math.max(8, (height / 100) * 28)}px`,
								minWidth: 2,
							}}
						/>
					))}
				</div>
				<span
					className={cn(
						"text-[10px] tabular-nums",
						isOwn ? "text-white/70" : "text-text-muted",
					)}
				>
					{isPlaying || currentTime > 0
						? formatTime(currentTime)
						: formatTime(totalDuration)}
				</span>
			</div>
		</div>
	);
});
