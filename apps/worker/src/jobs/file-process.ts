import { join } from "node:path";
import { db, eq, schema } from "@yam/db/pg";
import type { StreamJob } from "@yam/db/redis";

interface FileProcessPayload {
	fileId: string;
	storageKey: string;
	mimeType: string;
}

const STORAGE_PATH = process.env.STORAGE_LOCAL_PATH ?? "./uploads";

export async function processFile(job: StreamJob<FileProcessPayload>): Promise<void> {
	const { fileId, storageKey, mimeType } = job.data;
	const fullPath = join(STORAGE_PATH, storageKey);

	if (mimeType.startsWith("image/")) {
		try {
			const file = Bun.file(fullPath);
			const buffer = await file.arrayBuffer();

			console.log(`[Worker] Processed image ${fileId}: ${buffer.byteLength} bytes`);

			await db.update(schema.files).set({ width: 0, height: 0 }).where(eq(schema.files.id, fileId));
		} catch (err) {
			console.error(`[Worker] Failed to process image ${fileId}:`, err);
			throw err;
		}
	}

	if (mimeType.startsWith("audio/")) {
		try {
			console.log(`[Worker] Processing voice message ${fileId}`);

			const fakeWaveform = Array.from({ length: 50 }, () => Math.floor(Math.random() * 100));

			await db
				.update(schema.files)
				.set({ waveform: fakeWaveform })
				.where(eq(schema.files.id, fileId));
		} catch (err) {
			console.error(`[Worker] Failed to process audio ${fileId}:`, err);
			throw err;
		}
	}
}
