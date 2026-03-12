import { randomUUID } from "node:crypto";
import type { ServerEvent } from "@yam/shared";

type ErrorSeverity = "info" | "warning" | "error";
type ErrorScope = "auth" | "chat" | "message" | "system";

interface WsErrorOptions {
	severity?: ErrorSeverity;
	retryable?: boolean;
	scope?: ErrorScope;
}

const ERROR_DEFAULTS: Record<string, WsErrorOptions> = {
	AUTH_FAILED: { severity: "error", retryable: false, scope: "auth" },
	AUTH_REQUIRED: { severity: "error", retryable: false, scope: "auth" },
	AUTH_TIMEOUT: { severity: "error", retryable: true, scope: "auth" },
	ACCOUNT_SUSPENDED: { severity: "error", retryable: false, scope: "auth" },
	ALREADY_AUTHENTICATED: { severity: "info", retryable: false, scope: "auth" },
	PARSE_ERROR: { severity: "warning", retryable: true, scope: "system" },
	INVALID_FORMAT: { severity: "warning", retryable: true, scope: "system" },
	UNKNOWN_EVENT: { severity: "warning", retryable: false, scope: "system" },
	INTERNAL_ERROR: { severity: "error", retryable: true, scope: "system" },
};

export function withEventId<T extends { event: string }>(event: T): T & { eventId: string } {
	return { ...event, eventId: randomUUID() };
}

export function sendWsError(ws: any, code: string, message: string, opts?: WsErrorOptions): void {
	const defaults = ERROR_DEFAULTS[code] ?? { severity: "error", retryable: false, scope: "system" };
	const errorEvent: ServerEvent = withEventId({
		event: "error" as const,
		data: {
			code,
			message,
			severity: (opts?.severity ?? defaults.severity ?? "error") as ErrorSeverity,
			retryable: opts?.retryable ?? defaults.retryable ?? false,
			scope: (opts?.scope ?? defaults.scope ?? "system") as ErrorScope,
		},
	});
	ws.send(JSON.stringify(errorEvent));
}
