import { env } from "@/env";
import { useAuthStore } from "@/stores/auth";

let refreshPromise: Promise<boolean> | null = null;

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
	const token = localStorage.getItem("accessToken");

	const headers: Record<string, string> = {
		...(options.headers as Record<string, string>),
	};

	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	if (!(options.body instanceof FormData)) {
		headers["Content-Type"] = "application/json";
	}

	const res = await fetch(`${env.apiBase}${path}`, {
		...options,
		headers,
	});

	if (res.status === 401) {
		const refreshed = await tryRefreshToken();
		if (refreshed) {
			const retryHeaders = { ...headers };
			const newToken = localStorage.getItem("accessToken");
			if (newToken) retryHeaders.Authorization = `Bearer ${newToken}`;
			return request(path, { ...options, headers: retryHeaders });
		}
		useAuthStore.getState().logout();
		window.location.href = "/login";
		throw new Error("Unauthorized");
	}

	if (!res.ok) {
		const error = await res.json().catch(() => ({ error: res.statusText }));
		throw new Error(error.error || res.statusText);
	}

	if (res.status === 204) return undefined as T;
	return res.json();
}

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

		if (!res.ok) return false;

		const data = await res.json();
		localStorage.setItem("accessToken", data.accessToken);
		localStorage.setItem("refreshToken", data.refreshToken);
		return true;
	} catch {
		return false;
	}
}

export const api = {
	get: <T>(path: string) => request<T>(path),

	post: <T>(path: string, body?: unknown) =>
		request<T>(path, {
			method: "POST",
			body: body ? JSON.stringify(body) : undefined,
		}),

	patch: <T>(path: string, body?: unknown) =>
		request<T>(path, {
			method: "PATCH",
			body: body ? JSON.stringify(body) : undefined,
		}),

	delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),

	upload: <T>(path: string, file: File) => {
		const form = new FormData();
		form.append("file", file);
		return request<T>(path, { method: "POST", body: form });
	},
};
