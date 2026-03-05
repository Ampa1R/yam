export const env = {
	apiBase: import.meta.env.VITE_API_BASE ?? "/api",
	wsBase: import.meta.env.VITE_WS_BASE ?? "/ws",
	maxFileSizeMb: Number(import.meta.env.VITE_MAX_FILE_SIZE_MB ?? 50),
	maxMessageLength: Number(import.meta.env.VITE_MAX_MESSAGE_LENGTH ?? 4096),
} as const;

export const ALLOWED_FILE_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/avif",
	"video/mp4",
	"video/webm",
	"audio/mpeg",
	"audio/ogg",
	"audio/webm",
	"application/pdf",
	"application/zip",
	"application/x-7z-compressed",
	"application/x-rar-compressed",
	"text/plain",
	"application/msword",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
