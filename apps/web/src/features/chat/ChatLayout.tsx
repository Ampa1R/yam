import { useQuery } from "@tanstack/react-query";
import type { InboxItem } from "@yam/shared";
import { useEffect } from "react";
import { useWebSocket } from "@/hooks/useWebSocket";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";
import { ChatSidebar } from "./ChatSidebar";
import { ChatView } from "./ChatView";

export function ChatLayout() {
	const { setUser } = useAuthStore();
	const { activeChatId, setInbox } = useChatStore();
	const ws = useWebSocket();

	const {
		data: userData,
		isLoading: userLoading,
		isError: userError,
	} = useQuery({
		queryKey: ["me"],
		queryFn: () => api.get<any>("/users/me"),
	});

	const {
		data: inboxData,
		isLoading: inboxLoading,
		isError: inboxError,
	} = useQuery({
		queryKey: ["inbox"],
		queryFn: () => api.get<{ chats: InboxItem[] }>("/chats"),
		refetchInterval: 30_000,
	});

	useEffect(() => {
		if (userData) setUser(userData);
	}, [userData, setUser]);

	useEffect(() => {
		if (inboxData?.chats) setInbox(inboxData.chats);
	}, [inboxData, setInbox]);

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
		<div className="flex h-screen bg-surface-secondary">
			<ChatSidebar />
			<main className="flex flex-1 flex-col">
				{activeChatId ? (
					<ChatView chatId={activeChatId} ws={ws} />
				) : (
					<div className="flex flex-1 items-center justify-center">
						<div className="text-center">
							<h2 className="text-2xl font-semibold text-text-secondary">YAM</h2>
							<p className="mt-2 text-text-muted">Select a chat or start a new conversation</p>
						</div>
					</div>
				)}
			</main>
		</div>
	);
}
