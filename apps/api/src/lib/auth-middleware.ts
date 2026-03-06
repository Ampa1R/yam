import { Elysia } from "elysia";
import { verifyAccessToken } from "./jwt";

export const authMiddleware = new Elysia({ name: "auth" })
	.derive(async ({ request }) => {
		const header = request.headers.get("authorization");
		if (!header?.startsWith("Bearer ")) {
			return { userId: null as string | null, userRole: null as number | null };
		}

		const token = header.slice(7);
		const payload = await verifyAccessToken(token);

		if (!payload) {
			return { userId: null as string | null, userRole: null as number | null };
		}

		return { userId: payload.sub, userRole: payload.role };
	})
	.macro({
		requireAuth(enabled: boolean) {
			if (!enabled) return;
			return {
				beforeHandle({ userId, userRole, set }) {
					if (!userId) {
						set.status = 401;
						return { error: "Unauthorized" };
					}
					if (userRole != null && userRole < 0) {
						set.status = 403;
						return { error: "Account suspended" };
					}
				},
			};
		},
	})
	.as("global");
