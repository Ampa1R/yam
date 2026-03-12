import { useSyncExternalStore } from "react";

export type ConnectionStatus = "connected" | "connecting" | "disconnected";

let globalStatus: ConnectionStatus = "disconnected";
const statusListeners = new Set<() => void>();

export function setGlobalStatus(status: ConnectionStatus) {
	globalStatus = status;
	for (const listener of statusListeners) listener();
}

export function useConnectionStatus(): ConnectionStatus {
	return useSyncExternalStore(
		(cb) => {
			statusListeners.add(cb);
			return () => statusListeners.delete(cb);
		},
		() => globalStatus,
	);
}
