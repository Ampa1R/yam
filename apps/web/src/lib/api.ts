import { useAuthStore } from "@/stores/auth";

const API_BASE = "/api";

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

	const res = await fetch(`${API_BASE}${path}`, {
		...options,
		headers,
	});

	if (res.status === 401) {
		const refreshed = await tryRefreshToken();
		if (refreshed) {
			return request(path, options);
		}
		useAuthStore.getState().logout();
		window.location.href = "/login";
		throw new Error("Unauthorized");
	}

	if (!res.ok) {
		const error = await res.json().catch(() => ({ error: res.statusText }));
		throw new Error(error.error || res.statusText);
	}

	return res.json();
}

async function tryRefreshToken(): Promise<boolean> {
	const refreshToken = localStorage.getItem("refreshToken");
	if (!refreshToken) return false;

	try {
		const res = await fetch(`${API_BASE}/auth/refresh`, {
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
