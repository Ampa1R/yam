import type { InboxItem } from "@yam/shared";
import { formatDistanceToNow } from "date-fns";
import { LogOut, MessageSquare, Plus, Search, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";
import { ContactsDialog } from "./ContactsDialog";
import { NewChatDialog } from "./NewChatDialog";
import { ProfileDialog } from "./ProfileDialog";

function getInboxDisplayName(item: InboxItem, _userId: string | undefined): string {
	if (item.chatName) return item.chatName;
	return "Chat";
}

function getMessagePreview(item: InboxItem): string {
	if (!item.lastMsgPreview) return "No messages";
	return item.lastMsgPreview;
}

export function ChatSidebar() {
	const { inbox, activeChatId, setActiveChatId } = useChatStore();
	const { user, logout } = useAuthStore();
	const [searchQuery, setSearchQuery] = useState("");
	const [showNewChat, setShowNewChat] = useState(false);
	const [showProfile, setShowProfile] = useState(false);
	const [showContacts, setShowContacts] = useState(false);

	const filteredInbox = useMemo(
		() =>
			inbox.filter((item) => {
				const name = getInboxDisplayName(item, user?.id);
				return name.toLowerCase().includes(searchQuery.toLowerCase());
			}),
		[inbox, searchQuery, user?.id],
	);

	const _totalUnread = inbox.reduce((sum, item) => sum + item.unreadCount, 0);

	return (
		<aside className="flex w-80 flex-col border-r border-border bg-surface lg:w-96">
			<header className="flex items-center justify-between border-b border-border px-4 py-3">
				<button
					onClick={() => setShowProfile(true)}
					className="flex items-center gap-2 rounded-lg px-1 py-0.5 transition-colors hover:bg-surface-hover"
				>
					<div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">
						{user?.displayName?.charAt(0)?.toUpperCase() ?? "U"}
					</div>
					<div className="text-left">
						<span className="block text-sm font-semibold text-text-primary">
							{user?.displayName ?? "User"}
						</span>
						{user?.statusText && (
							<span className="block max-w-[120px] truncate text-xs text-text-muted">
								{user.statusText}
							</span>
						)}
					</div>
				</button>
				<div className="flex items-center gap-0.5">
					<button
						onClick={() => setShowContacts(true)}
						className="rounded-lg p-2 text-text-secondary hover:bg-surface-hover"
						title="Contacts"
					>
						<Users size={18} />
					</button>
					<button
						onClick={() => setShowNewChat(true)}
						className="rounded-lg p-2 text-text-secondary hover:bg-surface-hover"
						title="New chat"
					>
						<Plus size={18} />
					</button>
					<button
						onClick={logout}
						className="rounded-lg p-2 text-text-secondary hover:bg-surface-hover"
						title="Logout"
					>
						<LogOut size={18} />
					</button>
				</div>
			</header>

			<div className="px-3 py-2">
				<div className="relative">
					<Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
					<input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search chats..."
						className={cn(
							"w-full rounded-lg border-none bg-surface-secondary py-2 pl-9 pr-3 text-sm",
							"text-text-primary placeholder:text-text-muted",
							"focus:outline-none focus:ring-1 focus:ring-primary",
						)}
					/>
				</div>
			</div>

			<div className="flex-1 overflow-y-auto">
				{filteredInbox.length === 0 ? (
					<div className="flex flex-col items-center justify-center py-12 text-text-muted">
						<MessageSquare size={48} strokeWidth={1} />
						<p className="mt-3 text-sm">No chats yet</p>
						<button
							onClick={() => setShowNewChat(true)}
							className="mt-3 text-sm text-primary hover:underline"
						>
							Start a conversation
						</button>
					</div>
				) : (
					filteredInbox.map((item) => (
						<button
							key={item.chatId}
							onClick={() => setActiveChatId(item.chatId)}
							className={cn(
								"flex w-full items-center gap-3 px-3 py-3 text-left transition-colors",
								activeChatId === item.chatId ? "bg-primary/10" : "hover:bg-surface-hover",
							)}
						>
							<div className="relative">
								<div
									className={cn(
										"flex h-12 w-12 shrink-0 items-center justify-center rounded-full font-semibold",
										item.chatType === 1
											? "bg-success/20 text-success"
											: "bg-primary/20 text-primary",
									)}
								>
									{getInboxDisplayName(item, user?.id).charAt(0)?.toUpperCase() ?? "?"}
								</div>
								{item.chatType === 1 && (
									<div className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-surface">
										<Users size={10} className="text-text-muted" />
									</div>
								)}
							</div>
							<div className="min-w-0 flex-1">
								<div className="flex items-center justify-between">
									<span className="truncate font-medium text-text-primary">
										{getInboxDisplayName(item, user?.id)}
									</span>
									{item.lastActivity && (
										<span className="ml-2 shrink-0 text-xs text-text-muted">
											{formatDistanceToNow(new Date(item.lastActivity), {
												addSuffix: false,
											})}
										</span>
									)}
								</div>
								<div className="flex items-center justify-between">
									<span className="truncate text-sm text-text-secondary">
										{getMessagePreview(item)}
									</span>
									{item.unreadCount > 0 && (
										<span className="ml-2 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-white">
											{item.unreadCount > 99 ? "99+" : item.unreadCount}
										</span>
									)}
								</div>
							</div>
						</button>
					))
				)}
			</div>

			{showNewChat && <NewChatDialog onClose={() => setShowNewChat(false)} />}
			{showProfile && <ProfileDialog onClose={() => setShowProfile(false)} />}
			{showContacts && <ContactsDialog onClose={() => setShowContacts(false)} />}
		</aside>
	);
}
