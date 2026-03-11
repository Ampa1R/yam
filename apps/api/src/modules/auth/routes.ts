import { and, db, eq, schema } from "@yam/db/pg";
import { otp, rateLimit } from "@yam/db/redis";
import { Elysia, t } from "elysia";
import { authMiddleware } from "../../lib/auth-middleware";
import { Errors } from "../../lib/errors";
import {
	createAccessToken,
	createRefreshToken,
	hashToken,
	verifyRefreshToken,
} from "@yam/shared/jwt";

const DEMO_ENABLED = process.env.OTP_DEMO_ENABLED === "true";
const DEMO_CODE = process.env.OTP_DEMO_CODE ?? "000000";
const DEMO_PHONES = new Set((process.env.OTP_DEMO_PHONES ?? "").split(",").filter(Boolean));

function extractIp(request: Request): string {
	const forwardedFor = request.headers.get("x-forwarded-for");
	if (forwardedFor) {
		const first = forwardedFor.split(",")[0]?.trim();
		if (first && first !== "unknown") return first;
	}
	const realIp = request.headers.get("x-real-ip");
	if (realIp) return realIp.trim();
	return "0.0.0.0";
}

export const authRoutes = new Elysia({ prefix: "/auth" })
	.post(
		"/request-otp",
		async ({ body, set, request }) => {
			const ip = extractIp(request);
			const allowed = await rateLimit.check(`${ip}:otp`, 5, 3600);
			if (!allowed) {
				set.status = 429;
				return { error: "Too many OTP requests. Try again later." };
			}

			const { phone } = body;
			const allowedByPhone = await rateLimit.check(`phone:${phone}:otp`, 3, 3600);
			if (!allowedByPhone) {
				set.status = 429;
				return { error: "Too many OTP requests for this phone. Try again later." };
			}

			if (DEMO_ENABLED && DEMO_PHONES.has(phone)) {
				await otp.set(phone, DEMO_CODE);
				return { success: true, demo: true };
			}

			const bytes = new Uint32Array(1);
			crypto.getRandomValues(bytes);
			const code = String(100000 + (bytes[0]! % 900000));
			await otp.set(phone, code);

			if (process.env.NODE_ENV !== "production") {
				console.log(`[OTP] Code for ${phone}: ${code}`);
			}

			return { success: true };
		},
		{
			body: t.Object({
				phone: t.String({ minLength: 10, maxLength: 20 }),
			}),
		},
	)
	.post(
		"/verify-otp",
		async ({ body, set, request }) => {
			const { phone, code } = body;

			const attempts = await otp.incrementAttempts(phone);
			if (attempts > 5) {
				set.status = 429;
				return { error: "Too many attempts. Request a new code." };
			}

			const storedCode = await otp.get(phone);
			if (!storedCode || storedCode !== code) {
				set.status = 400;
				return { error: "Invalid or expired code" };
			}

			const ip = extractIp(request);

			let [user] = await db
				.select()
				.from(schema.users)
				.where(eq(schema.users.phone, phone))
				.limit(1);

			if (!user) {
				const displayName = `User ${phone.slice(-4)}`;
				[user] = await db.insert(schema.users).values({ phone, displayName }).returning();
			}

			if (!user) throw Errors.internal("Failed to create user");

			const accessToken = await createAccessToken(user.id, user.role);
			const refreshToken = await createRefreshToken(user.id, user.role);

			const tokenHash = await hashToken(refreshToken);
			const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

			await db.insert(schema.refreshTokens).values({
				userId: user.id,
				tokenHash,
				deviceInfo: null,
				expiresAt,
			});

			await otp.del(phone);
			await otp.resetAttempts(phone);
			await rateLimit.reset(`phone:${phone}:otp`);
			await rateLimit.reset(`${ip}:otp`);

			return {
				accessToken,
				refreshToken,
				user: {
					id: user.id,
					phone: user.phone,
					username: user.username,
					displayName: user.displayName,
					avatarUrl: user.avatarUrl,
					statusText: user.statusText,
					isProfilePublic: user.isProfilePublic,
					role: user.role,
					createdAt: user.createdAt.toISOString(),
					updatedAt: user.updatedAt.toISOString(),
				},
			};
		},
		{
			body: t.Object({
				phone: t.String({ minLength: 10, maxLength: 20 }),
				code: t.String({ minLength: 6, maxLength: 6 }),
			}),
		},
	)
	.post(
		"/refresh",
		async ({ body, set, request }) => {
			const ip = extractIp(request);
			const allowed = await rateLimit.check(`${ip}:refresh`, 10, 60);
			if (!allowed) {
				set.status = 429;
				return { error: "Too many refresh requests. Try again later." };
			}

			const { refreshToken } = body;
			const payload = await verifyRefreshToken(refreshToken);

			if (!payload) {
				set.status = 401;
				return { error: "Invalid refresh token" };
			}

			const tokenHash = await hashToken(refreshToken);
			const [rotatedToken] = await db
				.delete(schema.refreshTokens)
				.where(eq(schema.refreshTokens.tokenHash, tokenHash))
				.returning({ userId: schema.refreshTokens.userId, expiresAt: schema.refreshTokens.expiresAt });

			if (!rotatedToken || rotatedToken.expiresAt < new Date()) {
				set.status = 401;
				return { error: "Refresh token expired or revoked" };
			}

			const [user] = await db
				.select()
				.from(schema.users)
				.where(eq(schema.users.id, rotatedToken.userId))
				.limit(1);

			if (!user) {
				set.status = 401;
				return { error: "User not found" };
			}

			if (user.role < 0) {
				await db.delete(schema.refreshTokens).where(eq(schema.refreshTokens.userId, user.id));
				set.status = 403;
				return { error: "Account suspended" };
			}

			const newAccessToken = await createAccessToken(user.id, user.role);
			const newRefreshToken = await createRefreshToken(user.id, user.role);
			const newTokenHash = await hashToken(newRefreshToken);
			const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

			await db.insert(schema.refreshTokens).values({
				userId: user.id,
				tokenHash: newTokenHash,
				expiresAt,
			});

			return { accessToken: newAccessToken, refreshToken: newRefreshToken };
		},
		{
			body: t.Object({
				refreshToken: t.String(),
			}),
		},
	)
	.use(authMiddleware)
	.post(
		"/logout",
		async ({ userId, body, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			if (body?.refreshToken) {
				const tokenHash = await hashToken(body.refreshToken);
				await db
					.delete(schema.refreshTokens)
					.where(
						and(
							eq(schema.refreshTokens.userId, userId),
							eq(schema.refreshTokens.tokenHash, tokenHash),
						),
					);
			} else {
				await db.delete(schema.refreshTokens).where(eq(schema.refreshTokens.userId, userId));
			}

			return { success: true };
		},
		{
			requireAuth: true,
			body: t.Optional(
				t.Object({
					refreshToken: t.Optional(t.String()),
				}),
			),
		},
	);
