const isProd = process.env.NODE_ENV === "production";
const MIN_SECRET_LENGTH = 32;

function resolveSecret(envName: "JWT_SECRET" | "JWT_REFRESH_SECRET", fallback: string): string {
	const value = process.env[envName];
	if (value && value.length >= MIN_SECRET_LENGTH) {
		return value;
	}

	if (isProd) {
		throw new Error(
			`[JWT] ${envName} must be set and at least ${MIN_SECRET_LENGTH} characters in production`,
		);
	}

	return value ?? fallback;
}

const JWT_SECRET = resolveSecret("JWT_SECRET", "dev-secret-change-me");
const JWT_REFRESH_SECRET = resolveSecret("JWT_REFRESH_SECRET", "dev-refresh-secret-change-me");
const ACCESS_EXPIRES_IN_MS = 15 * 60 * 1000;
const REFRESH_EXPIRES_IN_MS = 7 * 24 * 60 * 60 * 1000;

export interface JwtPayload {
	sub: string;
	role: number;
	iat: number;
	exp: number;
}

function base64UrlEncode(str: string): string {
	return btoa(str).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(str: string): string {
	return atob(str.replace(/-/g, "+").replace(/_/g, "/"));
}

function importKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		[usage],
	);
}

const keys = {
	accessSign: importKey(JWT_SECRET, "sign"),
	accessVerify: importKey(JWT_SECRET, "verify"),
	refreshSign: importKey(JWT_REFRESH_SECRET, "sign"),
	refreshVerify: importKey(JWT_REFRESH_SECRET, "verify"),
};

async function signToken(
	payload: Omit<JwtPayload, "iat" | "exp">,
	keyPromise: Promise<CryptoKey>,
	expiresInMs: number,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const fullPayload: JwtPayload = {
		...payload,
		iat: now,
		exp: now + Math.floor(expiresInMs / 1000),
	};

	const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const body = base64UrlEncode(JSON.stringify(fullPayload));
	const key = await keyPromise;
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`));
	const sig = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));

	return `${header}.${body}.${sig}`;
}

async function verifyToken(token: string, keyPromise: Promise<CryptoKey>): Promise<JwtPayload | null> {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;

		const [header, body, signature] = parts;
		const key = await keyPromise;

		const sigBytes = Uint8Array.from(base64UrlDecode(signature!), (c) => c.charCodeAt(0));
		const valid = await crypto.subtle.verify(
			"HMAC",
			key,
			sigBytes,
			new TextEncoder().encode(`${header}.${body}`),
		);

		if (!valid) return null;

		const payload = JSON.parse(base64UrlDecode(body!)) as JwtPayload;
		if (payload.exp < Math.floor(Date.now() / 1000)) return null;

		return payload;
	} catch {
		return null;
	}
}

export async function createAccessToken(userId: string, role: number): Promise<string> {
	return signToken({ sub: userId, role }, keys.accessSign, ACCESS_EXPIRES_IN_MS);
}

export async function createRefreshToken(userId: string, role: number): Promise<string> {
	return signToken({ sub: userId, role }, keys.refreshSign, REFRESH_EXPIRES_IN_MS);
}

export async function verifyAccessToken(token: string): Promise<JwtPayload | null> {
	return verifyToken(token, keys.accessVerify);
}

export async function verifyRefreshToken(token: string): Promise<JwtPayload | null> {
	return verifyToken(token, keys.refreshVerify);
}

export async function hashToken(token: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
