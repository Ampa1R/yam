import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { InboxItem } from "@yam/shared";
import { formatDistanceToNow } from "date-fns";
import { BellOff, LogOut, MessageSquare, MoreVertical, Pin, PinOff, Plus, Search, Trash2, Users } from "lucide-react";
import { memo, useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import { toast } from "@/components/Toast";
import { api, eden } from "@/lib/api";
import { cn } from "@/lib/cn";
import { queryClient } from "@/lib/queryClient";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";
import { ContactsDialog } from "./ContactsDialog";
import { NewChatDialog } from "./NewChatDialog";
import { ProfileDialog } from "./ProfileDialog";

function getInboxDisplayName(item: InboxItem): string {
	if (item.chatName) return item.chatName;
	return "Chat";
}

function getMessagePreview(item: InboxItem): string {
	if (!item.lastMsgPreview) return "No messages";
	return item.lastMsgPreview;
}

export function ChatSidebar({ className }: { className?: string }) {
	const inbox = useChatStore((s) => s.inbox);
	const activeChatId = useChatStore((s) => s.activeChatId);
	const setActiveChatId = useChatStore((s) => s.setActiveChatId);
	const togglePin = useChatStore((s) => s.togglePin);
	const updateInboxItem = useChatStore((s) => s.updateInboxItem);
	const { user, logout } = useAuthStore();

	const handleTogglePin = useCallback(
		(chatId: string) => {
			togglePin(chatId);
			const item = useChatStore.getState().inbox.find((i) => i.chatId === chatId);
			eden(
				api.api.chats({ id: chatId }).membership.patch({ isPinned: item?.isPinned ?? false }),
			).catch(() => {
				togglePin(chatId);
			});
		},
		[togglePin],
	);

	const handleToggleMute = useCallback(
		(chatId: string, currentMuted: boolean) => {
			updateInboxItem(chatId, { isMuted: !currentMuted });
			eden(api.api.chats({ id: chatId }).membership.patch({ isMuted: !currentMuted })).catch(() => {
				updateInboxItem(chatId, { isMuted: currentMuted });
			});
		},
		[updateInboxItem],
	);

	const [confirmAction, setConfirmAction] = useState<{ chatId: string; chatType: number } | null>(null);

	const executeDeleteOrLeave = useCallback(
		async (chatId: string, chatType: number) => {
			try {
				if (chatType === 1) {
					await eden(api.api.chats({ id: chatId }).leave.delete());
				} else {
					await eden(api.api.chats({ id: chatId }).delete());
				}
				const state = useChatStore.getState();
				state.clearChat(chatId);
				state.setInbox(state.inbox.filter((i) => i.chatId !== chatId));
				if (state.activeChatId === chatId) {
					state.setActiveChatId(null);
				}
				void queryClient.invalidateQueries({ queryKey: ["inbox"] });
			} catch (err) {
				console.error("Delete/leave failed:", err);
				toast({
					title: chatType === 1 ? "Failed to leave group" : "Failed to delete chat",
					variant: "error",
				});
			}
		},
		[],
	);
	const [searchQuery, setSearchQuery] = useState("");
	const deferredSearch = useDeferredValue(searchQuery);
	const [showNewChat, setShowNewChat] = useState(false);
	const [showProfile, setShowProfile] = useState(false);
	const [showContacts, setShowContacts] = useState(false);
	const listRef = useRef<HTMLDivElement>(null);

	const filteredInbox = useMemo(
		() =>
			inbox.filter((item) => {
				if (!deferredSearch) return true;
				const name = getInboxDisplayName(item);
				return name.toLowerCase().includes(deferredSearch.toLowerCase());
			}),
		[inbox, deferredSearch],
	);

	const rowVirtualizer = useVirtualizer({
		count: filteredInbox.length,
		getScrollElement: () => listRef.current,
		getItemKey: (index) => filteredInbox[index]?.chatId ?? index,
		estimateSize: () => 76,
		overscan: 8,
	});
	const virtualRows = rowVirtualizer.getVirtualItems();

	return (
		<aside className={cn("w-full flex-col border-r border-border bg-surface lg:w-80 xl:w-96", className)}>
			<header className="flex items-center justify-between border-b border-border px-4 py-3">
				<button
					type="button"
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
					type="button"
					onClick={() => setShowContacts(true)}
					className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-text-secondary hover:bg-surface-hover"
					title="Contacts"
				>
					<Users size={18} />
				</button>
				<button
					type="button"
					onClick={() => setShowNewChat(true)}
					className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-text-secondary hover:bg-surface-hover"
					title="New chat"
				>
					<Plus size={18} />
				</button>
				<button
					type="button"
					onClick={logout}
					className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-text-secondary hover:bg-surface-hover"
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

			<div ref={listRef} className="flex-1 overflow-y-auto">
				{filteredInbox.length === 0 ? (
					<div className="flex flex-col items-center justify-center py-12 text-text-muted">
						<MessageSquare size={48} strokeWidth={1} />
						<p className="mt-3 text-sm">{deferredSearch ? "No matching chats" : "No chats yet"}</p>
						{!deferredSearch && (
							<button
								type="button"
								onClick={() => setShowNewChat(true)}
								className="mt-3 text-sm text-primary hover:underline"
							>
								Start a conversation
							</button>
						)}
					</div>
				) : (
					<div className="relative w-full" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
						{virtualRows.map((virtualRow) => {
							const item = filteredInbox[virtualRow.index];
							if (!item) return null;
							return (
								<div
									key={item.chatId}
									ref={rowVirtualizer.measureElement}
									data-index={virtualRow.index}
									className="absolute left-0 top-0 w-full"
									style={{ transform: `translateY(${virtualRow.start}px)` }}
								>
								<InboxEntry
									item={item}
									isActive={activeChatId === item.chatId}
									onSelect={() => setActiveChatId(item.chatId)}
									onTogglePin={() => handleTogglePin(item.chatId)}
									onToggleMute={() => handleToggleMute(item.chatId, item.isMuted)}
									onDeleteOrLeave={() => setConfirmAction({ chatId: item.chatId, chatType: item.chatType })}
								/>
								</div>
							);
						})}
					</div>
				)}
			</div>

			{showNewChat && <NewChatDialog onClose={() => setShowNewChat(false)} />}
			{showProfile && <ProfileDialog onClose={() => setShowProfile(false)} />}
			{showContacts && <ContactsDialog onClose={() => setShowContacts(false)} />}

			<AlertDialog.Root open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
				<AlertDialog.Portal>
					<AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 animate-[overlay-show_150ms_ease-out]" />
					<AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl bg-surface p-6 shadow-xl animate-[content-show_200ms_ease-out]">
						<AlertDialog.Title className="text-base font-semibold text-text-primary">
							{confirmAction?.chatType === 1 ? "Leave group?" : "Delete chat?"}
						</AlertDialog.Title>
						<AlertDialog.Description className="mt-2 text-sm text-text-secondary">
							{confirmAction?.chatType === 1
								? "You will no longer receive messages from this group."
								: "This chat and its messages will be permanently deleted."}
						</AlertDialog.Description>
						<div className="mt-5 flex justify-end gap-3">
							<AlertDialog.Cancel className="rounded-lg px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-hover">
								Cancel
							</AlertDialog.Cancel>
							<AlertDialog.Action
								onClick={() => {
									if (confirmAction) {
										executeDeleteOrLeave(confirmAction.chatId, confirmAction.chatType);
									}
								}}
								className="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white hover:bg-danger/90"
							>
								{confirmAction?.chatType === 1 ? "Leave" : "Delete"}
							</AlertDialog.Action>
						</div>
					</AlertDialog.Content>
				</AlertDialog.Portal>
			</AlertDialog.Root>
		</aside>
	);
}

const InboxEntry = memo(function InboxEntry({
	item,
	isActive,
	onSelect,
	onTogglePin,
	onToggleMute,
	onDeleteOrLeave,
}: {
	item: InboxItem;
	isActive: boolean;
	onSelect: () => void;
	onTogglePin: () => void;
	onToggleMute: () => void;
	onDeleteOrLeave: () => void;
}) {
	const displayName = getInboxDisplayName(item);
	const otherUserId = item.chatType === 0 ? item.otherUserId : null;
	const isOnline = useChatStore((s) =>
		otherUserId ? (s.presence.get(otherUserId)?.isOnline ?? false) : false,
	);

	return (
		<div
			className={cn(
				"group flex w-full items-center gap-3 px-3 py-3 text-left transition-colors",
				isActive ? "bg-primary/10" : "hover:bg-surface-hover",
			)}
		>
			<button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-3">
				<div className="relative">
					<div
						className={cn(
							"flex h-12 w-12 shrink-0 items-center justify-center rounded-full font-semibold",
							item.chatType === 1 ? "bg-success/20 text-success" : "bg-primary/20 text-primary",
						)}
					>
						{displayName.charAt(0)?.toUpperCase() ?? "?"}
					</div>
					{item.chatType === 1 && (
						<div className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-surface">
							<Users size={10} className="text-text-muted" />
						</div>
					)}
					{item.chatType === 0 && isOnline && (
						<div className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-surface bg-success" />
					)}
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-center justify-between">
						<span className="truncate font-medium text-text-primary">{displayName}</span>
						{item.lastActivity && (
							<span className="ml-2 shrink-0 text-xs text-text-muted">
								{formatDistanceToNow(new Date(item.lastActivity), {
									addSuffix: false,
								})}
							</span>
						)}
					</div>
					<div className="flex items-center justify-between">
						<span className="truncate text-sm text-text-secondary">{getMessagePreview(item)}</span>
						{item.unreadCount > 0 && (
							<span
								className={cn(
									"ml-2 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-medium text-white",
									item.isMuted ? "bg-text-muted" : "bg-primary",
								)}
							>
								{item.unreadCount > 99 ? "99+" : item.unreadCount}
							</span>
						)}
					</div>
				</div>
			</button>

			{item.isPinned && (
				<Pin size={14} className="shrink-0 text-primary lg:hidden" />
			)}

			<DropdownMenu.Root>
				<DropdownMenu.Trigger asChild>
					<button
						type="button"
						onClick={(e) => e.stopPropagation()}
						className={cn(
							"flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-lg text-text-muted transition-opacity",
							"hover:bg-surface-hover hover:text-text-primary",
							"lg:opacity-0 lg:group-hover:opacity-100",
						)}
						aria-label="Chat actions"
					>
						<MoreVertical size={16} />
					</button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						align="end"
						sideOffset={4}
						className="z-50 min-w-[160px] rounded-lg border border-border bg-surface p-1 shadow-lg animate-[slide-up_150ms_ease-out]"
					>
						<DropdownMenu.Item
							onSelect={onTogglePin}
							className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-text-primary outline-none hover:bg-surface-hover focus:bg-surface-hover"
						>
							{item.isPinned ? <PinOff size={15} /> : <Pin size={15} />}
							{item.isPinned ? "Unpin" : "Pin"}
						</DropdownMenu.Item>
						<DropdownMenu.Item
							onSelect={onToggleMute}
							className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-text-primary outline-none hover:bg-surface-hover focus:bg-surface-hover"
						>
							<BellOff size={15} />
							{item.isMuted ? "Unmute" : "Mute"}
						</DropdownMenu.Item>
						<DropdownMenu.Separator className="my-1 h-px bg-border" />
						<DropdownMenu.Item
							onSelect={onDeleteOrLeave}
							className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-danger outline-none hover:bg-danger/10 focus:bg-danger/10"
						>
							<Trash2 size={15} />
							{item.chatType === 1 ? "Leave group" : "Delete chat"}
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
		</div>
	);
});
