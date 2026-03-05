import type { UserRole } from "../constants";

export interface User {
	id: string;
	phone: string;
	username: string | null;
	displayName: string;
	avatarUrl: string | null;
	statusText: string | null;
	isProfilePublic: boolean;
	role: UserRole;
	createdAt: string;
	updatedAt: string;
}

export interface UserPublicProfile {
	id: string;
	displayName: string;
	username: string | null;
	avatarUrl: string | null;
	statusText: string | null;
	isOnline: boolean;
	lastSeen: string | null;
}

export interface Contact {
	userId: string;
	contactId: string;
	nickname: string | null;
	user: UserPublicProfile;
	createdAt: string;
}

export interface AuthTokens {
	accessToken: string;
	refreshToken: string;
}
