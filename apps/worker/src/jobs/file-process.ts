import { join } from "node:path";
import { db, eq, schema } from "@yam/db/pg";
import type { StreamJob } from "@yam/db/redis";

interface FileProcessPayload {
	fileId: string;
	storageKey: string;
	mimeType: string;
}

const STORAGE_PATH = process.env.STORAGE_LOCAL_PATH ?? "./uploads";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const JPEG_SOI = [0xff, 0xd8];
const GIF_SIGNATURES = [
	[0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
	[0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
];

function extractPngDimensions(buf: Buffer): { width: number; height: number } | null {
	if (buf.length < 24) return null;
	if (!PNG_SIGNATURE.every((b, i) => buf[i] === b)) return null;
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function extractJpegDimensions(buf: Buffer): { width: number; height: number } | null {
	if (buf.length < 2 || buf[0] !== JPEG_SOI[0] || buf[1] !== JPEG_SOI[1]) return null;
	let offset = 2;
	while (offset < buf.length - 1) {
		if (buf[offset] !== 0xff) break;
		const marker = buf[offset + 1]!;
		if (marker === 0xc0 || marker === 0xc2) {
			if (offset + 9 >= buf.length) return null;
			return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
		}
		if (marker === 0xd9 || marker === 0xda) break;
		const segLen = buf.readUInt16BE(offset + 2);
		offset += 2 + segLen;
	}
	return null;
}

function extractGifDimensions(buf: Buffer): { width: number; height: number } | null {
	if (buf.length < 10) return null;
	const isGif = GIF_SIGNATURES.some((sig) => sig.every((b, i) => buf[i] === b));
	if (!isGif) return null;
	return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function extractImageDimensions(buf: Buffer, mimeType: string): { width: number; height: number } | null {
	if (mimeType === "image/png" || mimeType === "image/apng") return extractPngDimensions(buf);
	if (mimeType === "image/jpeg" || mimeType === "image/jpg") return extractJpegDimensions(buf);
	if (mimeType === "image/gif") return extractGifDimensions(buf);
	return extractPngDimensions(buf) ?? extractJpegDimensions(buf) ?? extractGifDimensions(buf);
}

export async function processFile(job: StreamJob<FileProcessPayload>): Promise<void> {
	const { fileId, storageKey, mimeType } = job.data;
	const fullPath = join(STORAGE_PATH, storageKey);

	if (mimeType.startsWith("image/")) {
		try {
			const file = Bun.file(fullPath);
			const buffer = Buffer.from(await file.arrayBuffer());
			const dims = extractImageDimensions(buffer, mimeType);

			const updates: { width?: number; height?: number } = {};
			if (dims) {
				updates.width = Math.min(dims.width, 32767);
				updates.height = Math.min(dims.height, 32767);
			}

			if (Object.keys(updates).length > 0) {
				await db.update(schema.files).set(updates).where(eq(schema.files.id, fileId));
			}

			console.log(
				`[Worker] Processed image ${fileId}: ${buffer.byteLength} bytes, ${dims ? `${dims.width}x${dims.height}` : "dimensions unknown"}`,
			);
		} catch (err) {
			console.error(`[Worker] Failed to process image ${fileId}:`, err);
			throw err;
		}
	}

	if (mimeType.startsWith("audio/")) {
		try {
			const file = Bun.file(fullPath);
			const buffer = Buffer.from(await file.arrayBuffer());
			const samples = 50;
			const chunkSize = Math.max(1, Math.floor(buffer.length / samples));
			const waveform: number[] = [];
			for (let i = 0; i < samples; i++) {
				const offset = i * chunkSize;
				const end = Math.min(offset + chunkSize, buffer.length);
				let sum = 0;
				for (let j = offset; j < end; j++) {
					sum += Math.abs((buffer[j]! - 128));
				}
				waveform.push(Math.min(100, Math.round((sum / (end - offset)) * (100 / 128))));
			}

			await db.update(schema.files).set({ waveform }).where(eq(schema.files.id, fileId));
			console.log(`[Worker] Processed audio ${fileId}: waveform generated`);
		} catch (err) {
			console.error(`[Worker] Failed to process audio ${fileId}:`, err);
			throw err;
		}
	}
}
