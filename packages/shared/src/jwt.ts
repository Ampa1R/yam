const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? "dev-refresh-secret-change-me";
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

async function importKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		[usage],
	);
}

async function signToken(
	payload: Omit<JwtPayload, "iat" | "exp">,
	secret: string,
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
	const key = await importKey(secret, "sign");
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`));
	const sig = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));

	return `${header}.${body}.${sig}`;
}

async function verifyToken(token: string, secret: string): Promise<JwtPayload | null> {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;

		const [header, body, signature] = parts;
		const key = await importKey(secret, "verify");

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
	return signToken({ sub: userId, role }, JWT_SECRET, ACCESS_EXPIRES_IN_MS);
}

export async function createRefreshToken(userId: string, role: number): Promise<string> {
	return signToken({ sub: userId, role }, JWT_REFRESH_SECRET, REFRESH_EXPIRES_IN_MS);
}

export async function verifyAccessToken(token: string): Promise<JwtPayload | null> {
	return verifyToken(token, JWT_SECRET);
}

export async function verifyRefreshToken(token: string): Promise<JwtPayload | null> {
	return verifyToken(token, JWT_REFRESH_SECRET);
}

export async function hashToken(token: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
