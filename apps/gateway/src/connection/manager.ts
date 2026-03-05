import type { ServerEvent } from "@yam/shared";
import type { ServerWebSocket } from "bun";

export interface WsData {
	userId: string;
	connId: string;
}

class ConnectionManager {
	private connections = new Map<string, Map<string, ServerWebSocket<WsData>>>();

	add(userId: string, connId: string, ws: ServerWebSocket<WsData>): void {
		let userConns = this.connections.get(userId);
		if (!userConns) {
			userConns = new Map();
			this.connections.set(userId, userConns);
		}
		userConns.set(connId, ws);
	}

	remove(userId: string, connId: string): void {
		const userConns = this.connections.get(userId);
		if (!userConns) return;
		userConns.delete(connId);
		if (userConns.size === 0) {
			this.connections.delete(userId);
		}
	}

	getConnections(userId: string): ServerWebSocket<WsData>[] {
		const userConns = this.connections.get(userId);
		if (!userConns) return [];
		return Array.from(userConns.values());
	}

	isLocal(userId: string): boolean {
		return this.connections.has(userId);
	}

	sendToUser(userId: string, event: ServerEvent): void {
		const conns = this.getConnections(userId);
		if (conns.length === 0) return;
		const msg = JSON.stringify(event);
		for (const ws of conns) {
			try {
				ws.send(msg);
			} catch {
				// Connection may have closed
			}
		}
	}

	sendToUsers(userIds: string[], event: ServerEvent): void {
		const msg = JSON.stringify(event);
		for (const userId of userIds) {
			const conns = this.getConnections(userId);
			for (const ws of conns) {
				try {
					ws.send(msg);
				} catch {
					// Connection may have closed
				}
			}
		}
	}

	getOnlineUserIds(): string[] {
		return Array.from(this.connections.keys());
	}

	getConnectionCount(): number {
		let count = 0;
		for (const conns of this.connections.values()) {
			count += conns.size;
		}
		return count;
	}
}

export const connectionManager = new ConnectionManager();
