import { db, eq, schema } from "@yam/db/pg";
import { otp, rateLimit } from "@yam/db/redis";
import { Elysia, t } from "elysia";
import { authMiddleware } from "../../lib/auth-middleware";
import { Errors } from "../../lib/errors";
import {
	createAccessToken,
	createRefreshToken,
	hashToken,
	verifyRefreshToken,
} from "../../lib/jwt";

const DEMO_ENABLED = process.env.OTP_DEMO_ENABLED === "true";
const DEMO_CODE = process.env.OTP_DEMO_CODE ?? "000000";
const DEMO_PHONES = new Set((process.env.OTP_DEMO_PHONES ?? "").split(",").filter(Boolean));

export const authRoutes = new Elysia({ prefix: "/auth" })
	.post(
		"/request-otp",
		async ({ body, set, request }) => {
			const ip = request.headers.get("x-forwarded-for") ?? "unknown";
			const allowed = await rateLimit.check(`${ip}:otp`, 5, 3600);
			if (!allowed) {
				set.status = 429;
				return { error: "Too many OTP requests. Try again later." };
			}

			const { phone } = body;

			if (DEMO_ENABLED && DEMO_PHONES.has(phone)) {
				await otp.set(phone, DEMO_CODE);
				return { success: true, demo: true };
			}

			const code = String(Math.floor(100000 + Math.random() * 900000));
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
		async ({ body, set }) => {
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

			await otp.del(phone);

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
		async ({ body, set }) => {
			const { refreshToken } = body;
			const payload = await verifyRefreshToken(refreshToken);

			if (!payload) {
				set.status = 401;
				return { error: "Invalid refresh token" };
			}

			const tokenHash = await hashToken(refreshToken);
			const [stored] = await db
				.select()
				.from(schema.refreshTokens)
				.where(eq(schema.refreshTokens.tokenHash, tokenHash))
				.limit(1);

			if (!stored || stored.expiresAt < new Date()) {
				set.status = 401;
				return { error: "Refresh token expired or revoked" };
			}

			await db.delete(schema.refreshTokens).where(eq(schema.refreshTokens.id, stored.id));

			const [user] = await db
				.select()
				.from(schema.users)
				.where(eq(schema.users.id, payload.sub))
				.limit(1);

			if (!user) {
				set.status = 401;
				return { error: "User not found" };
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
		async ({ userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			await db.delete(schema.refreshTokens).where(eq(schema.refreshTokens.userId, userId));

			return { success: true };
		},
		{ requireAuth: true },
	);
