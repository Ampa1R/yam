import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { db, eq, schema, sql } from "@yam/db/pg";
import { queues, rateLimit } from "@yam/db/redis";
import { Elysia, t } from "elysia";
import { authMiddleware } from "../../lib/auth-middleware";

const STORAGE_PATH = process.env.STORAGE_LOCAL_PATH ?? "./uploads";
const MAX_FILE_SIZE = (Number(process.env.MAX_FILE_SIZE_MB) || 50) * 1024 * 1024;

const ALLOWED_MIME_PREFIXES = ["image/", "audio/", "video/"];
const ALLOWED_MIME_TYPES = new Set([
	"application/pdf",
	"application/zip",
	"application/x-zip-compressed",
	"text/plain",
	"text/csv",
	"application/json",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/msword",
	"application/vnd.ms-excel",
	"application/vnd.ms-powerpoint",
]);

function isAllowedMimeType(mime: string): boolean {
	if (ALLOWED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) return true;
	return ALLOWED_MIME_TYPES.has(mime);
}

export const filesRoutes = new Elysia({ prefix: "/files" })
	.use(authMiddleware)
	.post(
		"/upload",
		async ({ body, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const allowed = await rateLimit.check(`${userId}:upload`, 30, 60);
			if (!allowed) {
				set.status = 429;
				return { error: "Upload rate limit exceeded. Try again later." };
			}

			const { file } = body;

			if (!isAllowedMimeType(file.type)) {
				set.status = 400;
				return { error: "File type not allowed" };
			}

			if (file.size > MAX_FILE_SIZE) {
				set.status = 400;
				return { error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` };
			}

			const now = new Date();
			const datePath = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`;
			const rawExt = file.name.split(".").pop() ?? "bin";
			const ext = rawExt.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "bin";
			const fileId = randomUUID();
			const storageKey = `${datePath}/${fileId}.${ext}`;
			const fullPath = join(STORAGE_PATH, storageKey);

			await mkdir(join(STORAGE_PATH, datePath), { recursive: true });
			await Bun.write(fullPath, file);

			const isImage = file.type.startsWith("image/");
			const isAudio = file.type.startsWith("audio/");

			const [fileRecord] = await db
				.insert(schema.files)
				.values({
					uploaderId: userId,
					filename: file.name,
					mimeType: file.type,
					size: file.size,
					storageKey,
				})
				.returning();

			if (!fileRecord) {
				set.status = 500;
				return { error: "Failed to save file record" };
			}

			if (isImage || isAudio) {
				await queues.fileProcess.add({
					fileId: fileRecord.id,
					storageKey,
					mimeType: file.type,
				});
			}

			return {
				id: fileRecord.id,
				url: `/api/files/${fileRecord.id}`,
				filename: file.name,
				mimeType: file.type,
				size: file.size,
				width: null,
				height: null,
			};
		},
		{
			requireAuth: true,
			body: t.Object({
				file: t.File(),
			}),
		},
	)
	.get(
		"/:id/meta",
		async ({ params, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const [file] = await db
				.select({
					id: schema.files.id,
					filename: schema.files.filename,
					mimeType: schema.files.mimeType,
					size: schema.files.size,
					width: schema.files.width,
					height: schema.files.height,
					duration: schema.files.duration,
					waveform: schema.files.waveform,
				})
				.from(schema.files)
				.where(eq(schema.files.id, params.id))
				.limit(1);

			if (!file) {
				set.status = 404;
				return { error: "File not found" };
			}

			return {
				id: file.id,
				url: `/api/files/${file.id}`,
				filename: file.filename,
				mimeType: file.mimeType,
				size: file.size,
				width: file.width,
				height: file.height,
				duration: file.duration,
				waveform: file.waveform,
			};
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
		},
	)
	.get(
		"/:id",
		async ({ params, set }) => {
			const [file] = await db
				.select()
				.from(schema.files)
				.where(eq(schema.files.id, params.id))
				.limit(1);

			if (!file) {
				set.status = 404;
				return { error: "File not found" };
			}

			const fullPath = join(STORAGE_PATH, file.storageKey);
			const bunFile = Bun.file(fullPath);

			if (!(await bunFile.exists())) {
				set.status = 404;
				return { error: "File not found on disk" };
			}

			const safeName = file.filename.replace(/[^\w.\-]/g, "_");
			set.headers["content-type"] = file.mimeType;
			set.headers["content-disposition"] = `inline; filename="${safeName}"`;
			set.headers["cache-control"] = "private, max-age=86400, immutable";
			set.headers["x-content-type-options"] = "nosniff";

			return bunFile;
		},
		{
			params: t.Object({ id: t.String() }),
		},
	);
