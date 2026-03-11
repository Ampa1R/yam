import { redis } from "./client";

export interface StreamJob<T = unknown> {
	id: string;
	data: T;
	attempts: number;
}

export interface StreamQueueOptions {
	maxRetries?: number;
	claimIntervalMs?: number;
	claimTimeoutMs?: number;
	blockTimeoutMs?: number;
	batchSize?: number;
}

const DEFAULT_OPTIONS: Required<StreamQueueOptions> = {
	maxRetries: 3,
	claimIntervalMs: 30_000,
	claimTimeoutMs: 60_000,
	blockTimeoutMs: 2_000,
	batchSize: 10,
};

export class StreamQueue<T = unknown> {
	private readonly stream: string;
	private readonly dlq: string;
	private readonly group: string;
	private readonly opts: Required<StreamQueueOptions>;
	private running = false;
	private claimTimer: ReturnType<typeof setInterval> | null = null;

	constructor(name: string, opts?: StreamQueueOptions) {
		this.stream = `stream:${name}`;
		this.dlq = `stream:dlq:${name}`;
		this.group = "workers";
		this.opts = { ...DEFAULT_OPTIONS, ...opts };
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

	async process(consumerId: string, handler: (job: StreamJob<T>) => Promise<void>): Promise<void> {
		await this.init();
		this.running = true;

		this.claimTimer = setInterval(
			() => this.claimPending(consumerId, handler),
			this.opts.claimIntervalMs,
		);

		while (this.running) {
			try {
				const results = await redis.xreadgroup(
					"GROUP",
					this.group,
					consumerId,
					"COUNT",
					this.opts.batchSize,
					"BLOCK",
					this.opts.blockTimeoutMs,
					"STREAMS",
					this.stream,
					">",
				);

				if (!results) continue;

				const jobs: { id: string; job: StreamJob<T> }[] = [];
				for (const [, messages] of results as [string, [string, string[]][]][]) {
					for (const [msgId, fields] of messages) {
						const fieldMap = new Map<string, string>();
						for (let i = 0; i < fields.length; i += 2) {
							fieldMap.set(fields[i]!, fields[i + 1]!);
						}
						jobs.push({
							id: msgId,
							job: {
								id: msgId,
								data: JSON.parse(fieldMap.get("data") ?? "null") as T,
								attempts: Number.parseInt(fieldMap.get("attempts") ?? "0", 10),
							},
						});
					}
				}

				await Promise.all(
					jobs.map(async ({ id: msgId, job }) => {
						try {
							await handler(job);
							await redis.xack(this.stream, this.group, msgId);
						} catch (err) {
							console.error(`[StreamQueue:${this.stream}] Job ${msgId} failed:`, err);
							await this.retryOrDlq(msgId, job, err);
						}
					}),
				);
			} catch (err) {
				if (this.running) {
					console.error(`[StreamQueue:${this.stream}] Read error:`, err);
					await Bun.sleep(1000);
				}
			}
		}
	}

	private async claimPending(
		consumerId: string,
		handler: (job: StreamJob<T>) => Promise<void>,
	): Promise<void> {
		try {
			const pending = await redis.xpending(this.stream, this.group, "-", "+", 100);

			if (!Array.isArray(pending) || pending.length === 0) return;

			for (const entry of pending) {
				const [msgId, , idleTime] = entry as [string, string, number, number];
				if (idleTime < this.opts.claimTimeoutMs) continue;

				const claimed = await redis.xclaim(
					this.stream,
					this.group,
					consumerId,
					this.opts.claimTimeoutMs,
					msgId,
				);

				for (const [claimedId, fields] of claimed as [string, string[]][]) {
					if (!fields) continue;
					const fieldMap = new Map<string, string>();
					for (let i = 0; i < fields.length; i += 2) {
						fieldMap.set(fields[i]!, fields[i + 1]!);
					}

					const job: StreamJob<T> = {
						id: claimedId,
						data: JSON.parse(fieldMap.get("data") ?? "null") as T,
						attempts: Number.parseInt(fieldMap.get("attempts") ?? "0", 10),
					};

					if (job.attempts >= this.opts.maxRetries) {
						await this.moveToDlq(claimedId, job, "max_retries_exceeded");
					} else {
						try {
							await handler(job);
							await redis.xack(this.stream, this.group, claimedId);
						} catch (err) {
							await this.retryOrDlq(claimedId, job, err);
						}
					}
				}
			}
		} catch (err) {
			console.error(`[StreamQueue:${this.stream}] Claim error:`, err);
		}
	}

	private async moveToDlq(msgId: string, job: StreamJob<T>, error: string): Promise<void> {
		await redis.xadd(
			this.dlq,
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
		await redis.xack(this.stream, this.group, msgId);
	}

	private async retryOrDlq(msgId: string, job: StreamJob<T>, err: unknown): Promise<void> {
		const newAttempts = job.attempts + 1;
		const errorMessage = err instanceof Error ? err.message : String(err);
		if (newAttempts >= this.opts.maxRetries) {
			await this.moveToDlq(msgId, { ...job, attempts: newAttempts }, errorMessage);
			console.error(
				`[StreamQueue:${this.stream}] Job ${msgId} moved to DLQ after ${newAttempts} attempts`,
			);
			return;
		}

		await redis.eval(
			`redis.call('XADD', KEYS[1], '*', 'data', ARGV[1], 'attempts', ARGV[2])
			 redis.call('XACK', KEYS[1], ARGV[3], ARGV[4])
			 return 1`,
			1,
			this.stream,
			JSON.stringify(job.data),
			String(newAttempts),
			this.group,
			msgId,
		);
	}

	stop(): void {
		this.running = false;
		if (this.claimTimer) {
			clearInterval(this.claimTimer);
			this.claimTimer = null;
		}
	}
}

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
