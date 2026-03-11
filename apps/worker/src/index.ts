import { randomUUID } from "node:crypto";
import { connectRedis, disconnectRedis, queues } from "@yam/db/redis";
import { connectScylla, disconnectScylla } from "@yam/db/scylla";
import { startCronJobs } from "./crons/cleanup";
import { processFile } from "./jobs/file-process";
import { processInboxFanout } from "./jobs/inbox-fanout";

const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`;

await connectRedis();
await connectScylla();

console.log(`[Worker] ${WORKER_ID} starting...`);

await queues.inboxFanout.init();
await queues.fileProcess.init();
await queues.pushSend.init();

queues.inboxFanout.process(WORKER_ID, processInboxFanout);
queues.fileProcess.process(WORKER_ID, processFile);
queues.pushSend.process(WORKER_ID, async (job) => {
	console.log(`[Worker] Push notification stub for user ${job.data.userId}: ${job.data.title}`);
});

startCronJobs();

console.log(`[Worker] ${WORKER_ID} running, consuming queues...`);

let shuttingDown = false;
async function gracefulShutdown(signal: string) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[Worker] ${WORKER_ID} ${signal} received, shutting down...`);
	queues.inboxFanout.stop();
	queues.fileProcess.stop();
	queues.pushSend.stop();
	await disconnectRedis().catch(() => {});
	await disconnectScylla().catch(() => {});
	console.log(`[Worker] Shutdown complete`);
	process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
