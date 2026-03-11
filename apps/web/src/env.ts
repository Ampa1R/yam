function safeInt(raw: unknown, fallback: number): number {
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const env = {
	apiBase: import.meta.env.VITE_API_BASE ?? "/api",
	wsBase: import.meta.env.VITE_WS_BASE ?? "/ws",
	maxFileSizeMb: safeInt(import.meta.env.VITE_MAX_FILE_SIZE_MB, 50),
	maxMessageLength: safeInt(import.meta.env.VITE_MAX_MESSAGE_LENGTH, 4096),
} as const;
