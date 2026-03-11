import { treaty } from "@elysiajs/eden";
import type { App } from "@yam/api";
import { env } from "@/env";
import { useAuthStore } from "@/stores/auth";

export class AppError extends Error {
	code?: string;
	status?: number;

	constructor(message: string, options?: { code?: string; status?: number }) {
		super(message);
		this.name = "AppError";
		this.code = options?.code;
		this.status = options?.status;
	}
}

let refreshPromise: Promise<boolean> | null = null;

async function tryRefreshToken(): Promise<boolean> {
	if (refreshPromise) return refreshPromise;

	refreshPromise = doRefresh().finally(() => {
		refreshPromise = null;
	});

	return refreshPromise;
}

async function doRefresh(): Promise<boolean> {
	const refreshToken = localStorage.getItem("refreshToken");
	if (!refreshToken) return false;

	try {
		const res = await fetch(`${env.apiBase}/auth/refresh`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refreshToken }),
		});

		if (res.ok) {
			const data = await res.json();
			localStorage.setItem("accessToken", data.accessToken);
			localStorage.setItem("refreshToken", data.refreshToken);
			return true;
		}

		const currentToken = localStorage.getItem("refreshToken");
		if (currentToken && currentToken !== refreshToken) {
			return true;
		}

		return false;
	} catch {
		return false;
	}
}

function isSuspendedError(status: number, code?: string, message?: string): boolean {
	return (
		status === 403 &&
		(code === "ACCOUNT_SUSPENDED" ||
			code === "USER_BANNED" ||
			(message?.toLowerCase().includes("suspended") ?? false) ||
			(message?.toLowerCase().includes("banned") ?? false))
	);
}

async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const token = localStorage.getItem("accessToken");
	const headers = new Headers(init?.headers);
	if (token) headers.set("authorization", `Bearer ${token}`);

	let res = await fetch(input, { ...init, headers });

	if (res.status === 401) {
		const refreshed = await tryRefreshToken();
		if (refreshed) {
			const newToken = localStorage.getItem("accessToken");
			if (newToken) headers.set("authorization", `Bearer ${newToken}`);
			res = await fetch(input, { ...init, headers });
		}
	}

	return res;
}

const baseUrl = typeof window !== "undefined" ? window.location.origin : "http://localhost";

export const api = treaty<App>(baseUrl, {
	fetcher: authFetch,
});

export async function eden<T>(
	promise: Promise<{
		data: T;
		error: { status: unknown; value: unknown } | null;
		response: Response;
		status: number;
		headers: ResponseInit["headers"];
	}>,
): Promise<NonNullable<T>> {
	const result = await promise;

	if (result.error) {
		const errValue = result.error.value as Record<string, unknown> | null;
		const message = String(errValue?.error ?? errValue?.message ?? "Request failed");
		const code = errValue?.code as string | undefined;
		const status = Number(result.error.status) || result.status;

		if (status === 401) {
			useAuthStore.getState().logout();
			window.location.href = "/login";
		} else if (isSuspendedError(status, code, message)) {
			useAuthStore.getState().logout();
			window.location.href = "/login?reason=suspended";
		}

		throw new AppError(message, { code, status });
	}

	return result.data as NonNullable<T>;
}
