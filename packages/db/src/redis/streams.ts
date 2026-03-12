import type Redis from "ioredis";
import { redis } from "./client";

export interface StreamJob<T = unknown> {
	id: string;
	data: T;
	attempts: number;
}

/* producer */

export class StreamQueue<T = unknown> {
	readonly stream: string;
	readonly dlq: string;
	readonly group: string;
	readonly maxRetries: number;

	constructor(name: string, maxRetries = 3) {
		this.stream = `stream:${name}`;
		this.dlq = `stream:dlq:${name}`;
		this.group = "workers";
		this.maxRetries = maxRetries;
	}

	async init(): Promise<void> {
		try {
			await redis.xgroup("CREATE", this.stream, this.group, "0", "MKSTREAM");
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			if (!message.includes("BUSYGROUP")) throw err;
		}
	}

	async add(data: T): Promise<string> {
		const id = await redis.xadd(this.stream, "*", "data", JSON.stringify(data), "attempts", "0");
		return id!;
	}
}

/* consumer */

export interface ConsumerOptions {
	blockTimeoutMs?: number;
	batchSize?: number;
	claimIntervalMs?: number;
	claimTimeoutMs?: number;
}

interface Registration {
	queue: StreamQueue<unknown>;
	handler: (job: StreamJob<unknown>) => Promise<void>;
}

const CONSUMER_DEFAULTS: Required<ConsumerOptions> = {
	blockTimeoutMs: 2_000,
	batchSize: 10,
	claimIntervalMs: 30_000,
	claimTimeoutMs: 60_000,
};

export class StreamConsumer {
	private readonly opts: Required<ConsumerOptions>;
	private readonly registrations: Registration[] = [];
	private running = false;
	private blockingClient: Redis | null = null;
	private claimTimer: ReturnType<typeof setInterval> | null = null;

	constructor(opts?: ConsumerOptions) {
		this.opts = { ...CONSUMER_DEFAULTS, ...opts };
	}

	register<T>(queue: StreamQueue<T>, handler: (job: StreamJob<T>) => Promise<void>): this {
		this.registrations.push({
			queue: queue as StreamQueue<unknown>,
			handler: handler as (job: StreamJob<unknown>) => Promise<void>,
		});
		return this;
	}

	async start(consumerId: string): Promise<void> {
		if (this.registrations.length === 0) throw new Error("No queues registered");

		await Promise.all(this.registrations.map((r) => r.queue.init()));
		this.running = true;

		this.blockingClient = redis.duplicate();
		await this.blockingClient.connect();
		const reader = this.blockingClient;

		const handlerByStream = new Map<string, Registration>();
		for (const reg of this.registrations) {
			handlerByStream.set(reg.queue.stream, reg);
		}

		const streams = this.registrations.map((r) => r.queue.stream);
		const cursors = streams.map(() => ">");

		this.claimTimer = setInterval(
			() => this.claimAllPending(consumerId),
			this.opts.claimIntervalMs,
		);

		while (this.running) {
			try {
				const results = await reader.xreadgroup(
					"GROUP",
					"workers",
					consumerId,
					"COUNT",
					this.opts.batchSize,
					"BLOCK",
					this.opts.blockTimeoutMs,
					"STREAMS",
					...streams,
					...cursors,
				);

				if (!results) continue;

				const tasks: Promise<void>[] = [];

				for (const [streamKey, messages] of results as [string, [string, string[]][]][]) {
					const reg = handlerByStream.get(streamKey);
					if (!reg) continue;

					for (const [msgId, fields] of messages) {
						const job = parseJob(msgId, fields);
						tasks.push(
							reg
								.handler(job)
								.then(() => {
									redis.xack(streamKey, "workers", msgId);
								})
								.catch(async (err) => {
									console.error(`[StreamConsumer:${streamKey}] Job ${msgId} failed:`, err);
									await this.retryOrDlq(reg.queue, msgId, job, err);
								}),
						);
					}
				}

				if (tasks.length > 0) await Promise.all(tasks);
			} catch (err) {
				if (this.running) {
					console.error("[StreamConsumer] Read error:", err);
					await Bun.sleep(1000);
				}
			}
		}
	}

	stop(): void {
		this.running = false;
		if (this.claimTimer) {
			clearInterval(this.claimTimer);
			this.claimTimer = null;
		}
		if (this.blockingClient) {
			this.blockingClient.disconnect();
			this.blockingClient = null;
		}
	}

	/* pending / claim */

	private async claimAllPending(consumerId: string): Promise<void> {
		for (const { queue, handler } of this.registrations) {
			try {
				const pending = await redis.xpending(queue.stream, queue.group, "-", "+", 100);
				if (!Array.isArray(pending) || pending.length === 0) continue;

				for (const entry of pending) {
					const [msgId, , idleTime] = entry as [string, string, number, number];
					if (idleTime < this.opts.claimTimeoutMs) continue;

					const claimed = await redis.xclaim(
						queue.stream,
						queue.group,
						consumerId,
						this.opts.claimTimeoutMs,
						msgId,
					);

					for (const [claimedId, fields] of claimed as [string, string[]][]) {
						if (!fields) continue;
						const job = parseJob(claimedId, fields);

						if (job.attempts >= queue.maxRetries) {
							await this.moveToDlq(queue, claimedId, job, "max_retries_exceeded");
						} else {
							try {
								await handler(job);
								await redis.xack(queue.stream, queue.group, claimedId);
							} catch (err) {
								await this.retryOrDlq(queue, claimedId, job, err);
							}
						}
					}
				}
			} catch (err) {
				console.error(`[StreamConsumer:${queue.stream}] Claim error:`, err);
			}
		}
	}

	/* retry / dlq */

	private async moveToDlq(
		queue: StreamQueue<unknown>,
		msgId: string,
		job: StreamJob<unknown>,
		error: string,
	): Promise<void> {
		await redis.xadd(
			queue.dlq,
			"*",
			"data",
			JSON.stringify(job.data),
			"attempts",
			String(job.attempts),
			"original_id",
			msgId,
			"error",
			error,
		);
		await redis.xack(queue.stream, queue.group, msgId);
	}

	private async retryOrDlq(
		queue: StreamQueue<unknown>,
		msgId: string,
		job: StreamJob<unknown>,
		err: unknown,
	): Promise<void> {
		const newAttempts = job.attempts + 1;
		const errorMessage = err instanceof Error ? err.message : String(err);

		if (newAttempts >= queue.maxRetries) {
			await this.moveToDlq(queue, msgId, { ...job, attempts: newAttempts }, errorMessage);
			console.error(
				`[StreamConsumer:${queue.stream}] Job ${msgId} moved to DLQ after ${newAttempts} attempts`,
			);
			return;
		}

		await redis.eval(
			`redis.call('XADD', KEYS[1], '*', 'data', ARGV[1], 'attempts', ARGV[2])
			 redis.call('XACK', KEYS[1], ARGV[3], ARGV[4])
			 return 1`,
			1,
			queue.stream,
			JSON.stringify(job.data),
			String(newAttempts),
			queue.group,
			msgId,
		);
	}
}

/* helpers */

function parseJob(msgId: string, fields: string[]): StreamJob<unknown> {
	const fieldMap = new Map<string, string>();
	for (let i = 0; i < fields.length; i += 2) {
		fieldMap.set(fields[i]!, fields[i + 1]!);
	}
	return {
		id: msgId,
		data: JSON.parse(fieldMap.get("data") ?? "null"),
		attempts: Number.parseInt(fieldMap.get("attempts") ?? "0", 10),
	};
}

/* queue instances */

export const queues = {
	inboxFanout: new StreamQueue<{
		chatId: string;
		senderId: string;
		messageType: number;
		messagePreview: string;
		createdAt: string;
	}>("inbox-fanout"),

	fileProcess: new StreamQueue<{
		fileId: string;
		storageKey: string;
		mimeType: string;
	}>("file-process"),

	pushSend: new StreamQueue<{
		userId: string;
		title: string;
		body: string;
		data?: Record<string, string>;
	}>("push-send"),
};
