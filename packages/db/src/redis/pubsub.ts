import type { ServerEvent } from "@yam/shared";
import { createRedisSubscriber, redis } from "./client";

const USER_CHANNEL_PREFIX = "user:";

export function userChannel(userId: string): string {
	return `${USER_CHANNEL_PREFIX}${userId}`;
}

export async function publishToUser(userId: string, event: ServerEvent): Promise<void> {
	await redis.publish(userChannel(userId), JSON.stringify(event));
}

export async function publishToUsers(userIds: string[], event: ServerEvent): Promise<void> {
	if (userIds.length === 0) return;
	const message = JSON.stringify(event);
	const pipeline = redis.pipeline();
	for (const userId of userIds) {
		pipeline.publish(userChannel(userId), message);
	}
	await pipeline.exec();
}

export interface PubSubManager {
	subscribe(userId: string): Promise<void>;
	unsubscribe(userId: string): Promise<void>;
	onMessage(handler: (userId: string, event: ServerEvent) => void): void;
	shutdown(): Promise<void>;
}

export function createPubSubManager(): PubSubManager {
	const subscriber = createRedisSubscriber();
	let messageHandler: ((userId: string, event: ServerEvent) => void) | null = null;
	let connected = false;

	return {
		async subscribe(userId: string) {
			if (!connected) {
				await subscriber.connect();
				connected = true;
			}
			await subscriber.subscribe(userChannel(userId));
		},

		async unsubscribe(userId: string) {
			await subscriber.unsubscribe(userChannel(userId));
		},

		onMessage(handler) {
			messageHandler = handler;
			subscriber.on("message", (channel: string, message: string) => {
				if (!channel.startsWith(USER_CHANNEL_PREFIX)) return;
				const userId = channel.slice(USER_CHANNEL_PREFIX.length);
				try {
					const event = JSON.parse(message) as ServerEvent;
					messageHandler?.(userId, event);
				} catch {
					console.error("[PubSub] Failed to parse message:", message);
				}
			});
		},

		async shutdown() {
			await subscriber.quit();
			connected = false;
		},
	};
}
