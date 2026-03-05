import type { User } from "@yam/shared";
import { create } from "zustand";

interface AuthState {
	user: User | null;
	isAuthenticated: boolean;
	setUser: (user: User) => void;
	setTokens: (accessToken: string, refreshToken: string) => void;
	logout: () => void;
	hydrate: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
	user: null,
	isAuthenticated: !!localStorage.getItem("accessToken"),

	setUser: (user) => set({ user, isAuthenticated: true }),

	setTokens: (accessToken, refreshToken) => {
		localStorage.setItem("accessToken", accessToken);
		localStorage.setItem("refreshToken", refreshToken);
		set({ isAuthenticated: true });
	},

	logout: () => {
		localStorage.removeItem("accessToken");
		localStorage.removeItem("refreshToken");
		set({ user: null, isAuthenticated: false });
	},

	hydrate: () => {
		const hasToken = !!localStorage.getItem("accessToken");
		set({ isAuthenticated: hasToken });
	},
}));
