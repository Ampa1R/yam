import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { User } from "@yam/shared";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { useConnectionStatus, useWebSocket } from "@/hooks/useWebSocket";
import { api, eden } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";
import { ChatSidebar } from "./ChatSidebar";
import { ChatView } from "./ChatView";

const springTransition = { type: "spring" as const, damping: 28, stiffness: 320 };

export function ChatLayout() {
	const { setUser } = useAuthStore();
	const activeChatId = useChatStore((s) => s.activeChatId);
	const setInbox = useChatStore((s) => s.setInbox);
	const wsError = useChatStore((s) => s.wsError);
	const setWsError = useChatStore((s) => s.setWsError);
	const queryClient = useQueryClient();
	const ws = useWebSocket();
	const connectionStatus = useConnectionStatus();
	const isMobile = useIsMobile();
	const prevStatusRef = useRef(connectionStatus);

	const {
		data: userData,
		isLoading: userLoading,
		isError: userError,
	} = useQuery({
		queryKey: ["me"],
		queryFn: () => eden(api.api.users.me.get()),
	});

	const {
		data: inboxData,
		isLoading: inboxLoading,
		isError: inboxError,
	} = useQuery({
		queryKey: ["inbox"],
		queryFn: () => eden(api.api.chats.get()),
		refetchInterval: 60_000,
	});

	useEffect(() => {
		if (userData) setUser(userData as User);
	}, [userData, setUser]);

	useEffect(() => {
		if (inboxData?.chats) setInbox(inboxData.chats);
		if (inboxData?.presence) {
			const presenceMap = inboxData.presence as Record<string, { isOnline: boolean; lastSeen: string | null }>;
			const setPresence = useChatStore.getState().setPresence;
			for (const [uid, p] of Object.entries(presenceMap)) {
				setPresence(uid, { isOnline: p.isOnline, lastSeen: p.lastSeen, updatedAt: 0 });
			}
		}
	}, [inboxData, setInbox]);

	const totalUnread = useChatStore((s) => s.inbox.reduce((sum, item) => sum + (item.unreadCount ?? 0), 0));

	useEffect(() => {
		document.title = totalUnread > 0 ? `(${totalUnread}) YAM` : "YAM";
	}, [totalUnread]);

	useEffect(() => {
		const prev = prevStatusRef.current;
		prevStatusRef.current = connectionStatus;
		if (connectionStatus !== "connected") return;
		if (prev === "disconnected" || prev === "connecting") {
			void queryClient.invalidateQueries({ queryKey: ["me"] });
			void queryClient.invalidateQueries({ queryKey: ["inbox"] });
			if (activeChatId) {
				void queryClient.invalidateQueries({ queryKey: ["chat", activeChatId] });
				void queryClient.invalidateQueries({ queryKey: ["messages", activeChatId] });
			}
		}
	}, [connectionStatus, queryClient, activeChatId]);

	if (userLoading || inboxLoading) {
		return (
			<div className="flex h-screen items-center justify-center bg-surface-secondary">
				<div className="text-center">
					<div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
					<p className="text-sm text-text-muted">Loading YAM...</p>
				</div>
			</div>
		);
	}

	if (userError || inboxError) {
		return (
			<div className="flex h-screen items-center justify-center bg-surface-secondary">
				<div className="text-center">
					<p className="text-lg font-semibold text-danger">Failed to load</p>
					<p className="mt-1 text-sm text-text-muted">
						Check your connection and try refreshing the page.
					</p>
					<button
						type="button"
						onClick={() => window.location.reload()}
						className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
					>
						Retry
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-screen flex-col bg-surface-secondary">
			<ConnectionStatus status={connectionStatus} />
			{wsError && (
				<div className="flex items-center justify-between bg-danger px-4 py-1.5 text-xs font-medium text-white">
					<span className="truncate">{wsError.message}</span>
					<button
						type="button"
						onClick={() => setWsError(null)}
						className="ml-2 rounded p-0.5 hover:bg-white/20"
						aria-label="Dismiss websocket error"
					>
						<X size={12} />
					</button>
				</div>
			)}
			<div className="relative flex flex-1 overflow-hidden">
				{isMobile ? (
					<AnimatePresence mode="popLayout" initial={false}>
						{!activeChatId ? (
							<motion.aside
								key="sidebar"
								initial={{ x: "-100%" }}
								animate={{ x: 0 }}
								exit={{ x: "-100%" }}
								transition={springTransition}
								className="absolute inset-0 z-10 flex flex-col bg-surface"
							>
								<ChatSidebar />
							</motion.aside>
						) : (
							<motion.main
								key={`chat-${activeChatId}`}
								initial={{ x: "100%" }}
								animate={{ x: 0 }}
								exit={{ x: "100%" }}
								transition={springTransition}
								className="absolute inset-0 z-10 flex flex-col"
							>
								<ChatView chatId={activeChatId} ws={ws} />
							</motion.main>
						)}
					</AnimatePresence>
				) : (
					<>
						<ChatSidebar className="flex" />
						<main className="flex flex-1 flex-col">
							{activeChatId ? (
								<ChatView key={activeChatId} chatId={activeChatId} ws={ws} />
							) : (
								<div className="flex flex-1 items-center justify-center">
									<div className="text-center">
										<h2 className="text-2xl font-semibold text-text-secondary">YAM</h2>
										<p className="mt-2 text-text-muted">Select a chat or start a new conversation</p>
									</div>
								</div>
							)}
						</main>
					</>
				)}
			</div>
		</div>
	);
}
