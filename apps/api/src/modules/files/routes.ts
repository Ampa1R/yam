import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { db, eq, schema } from "@yam/db/pg";
import { queues } from "@yam/db/redis";
import { Elysia, t } from "elysia";
import { authMiddleware } from "../../lib/auth-middleware";

const STORAGE_PATH = process.env.STORAGE_LOCAL_PATH ?? "./uploads";
const MAX_FILE_SIZE = (Number(process.env.MAX_FILE_SIZE_MB) || 50) * 1024 * 1024;

export const filesRoutes = new Elysia({ prefix: "/files" })
	.use(authMiddleware)
	.post(
		"/upload",
		async ({ body, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const { file } = body;

			if (file.size > MAX_FILE_SIZE) {
				set.status = 400;
				return { error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` };
			}

			const now = new Date();
			const datePath = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`;
			const ext = file.name.split(".").pop() ?? "bin";
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
		"/:id",
		async ({ params, userId, set }) => {
			if (!userId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

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

			set.headers["content-type"] = file.mimeType;
			set.headers["content-disposition"] = `inline; filename="${file.filename}"`;
			set.headers["cache-control"] = "public, max-age=31536000, immutable";

			return bunFile;
		},
		{
			requireAuth: true,
			params: t.Object({ id: t.String() }),
		},
	);
