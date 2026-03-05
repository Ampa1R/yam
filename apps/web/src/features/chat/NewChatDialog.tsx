import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChatType } from "@yam/shared";
import { ArrowLeft, Check, Search, Users, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useChatStore } from "@/stores/chat";

interface SearchUser {
	id: string;
	displayName: string;
	username: string | null;
	avatarUrl: string | null;
	isOnline: boolean;
}

interface Props {
	onClose: () => void;
}

export function NewChatDialog({ onClose }: Props) {
	const [mode, setMode] = useState<"select" | "direct" | "group">("select");
	const [searchQuery, setSearchQuery] = useState("");
	const [groupName, setGroupName] = useState("");
	const [selectedMembers, setSelectedMembers] = useState<SearchUser[]>([]);
	const { setActiveChatId } = useChatStore();
	const queryClient = useQueryClient();

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	const { data: searchResults, isLoading: searchLoading } = useQuery({
		queryKey: ["user-search", searchQuery],
		queryFn: () =>
			api.get<{ users: SearchUser[] }>(`/users/search?q=${encodeURIComponent(searchQuery)}`),
		enabled: searchQuery.length >= 2,
	});

	const createDirectChat = useMutation({
		mutationFn: (userId: string) =>
			api.post<{ chat: { id: string }; created: boolean }>("/chats", {
				type: ChatType.DIRECT,
				memberIds: [userId],
			}),
		onSuccess: (data) => {
			setActiveChatId(data.chat.id);
			queryClient.invalidateQueries({ queryKey: ["inbox"] });
			onClose();
		},
	});

	const createGroupChat = useMutation({
		mutationFn: () =>
			api.post<{ chat: { id: string }; created: boolean }>("/chats", {
				type: ChatType.GROUP,
				memberIds: selectedMembers.map((m) => m.id),
				name: groupName,
			}),
		onSuccess: (data) => {
			setActiveChatId(data.chat.id);
			queryClient.invalidateQueries({ queryKey: ["inbox"] });
			onClose();
		},
	});

	const toggleMember = (user: SearchUser) => {
		setSelectedMembers((prev) =>
			prev.some((m) => m.id === user.id) ? prev.filter((m) => m.id !== user.id) : [...prev, user],
		);
	};

	const selectedIds = new Set(selectedMembers.map((m) => m.id));
	const error = createDirectChat.error || createGroupChat.error;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
			<div className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
				<div className="mb-4 flex items-center justify-between">
					<div className="flex items-center gap-2">
						{mode !== "select" && (
							<button
								type="button"
								onClick={() => {
									setMode("select");
									setSearchQuery("");
									setSelectedMembers([]);
									setGroupName("");
								}}
								className="rounded-lg p-1 hover:bg-surface-hover"
								aria-label="Back"
							>
								<ArrowLeft size={18} className="text-text-secondary" />
							</button>
						)}
						<h2 className="text-lg font-semibold text-text-primary">
							{mode === "select" && "New Chat"}
							{mode === "direct" && "Direct Message"}
							{mode === "group" && "New Group"}
						</h2>
					</div>
					<button type="button" onClick={onClose} className="rounded-lg p-1 hover:bg-surface-hover" aria-label="Close">
						<X size={20} className="text-text-secondary" />
					</button>
				</div>

				{error && (
					<div className="mb-3 rounded-lg bg-danger/10 px-4 py-2 text-sm text-danger">
						{error instanceof Error ? error.message : "Failed to create chat"}
					</div>
				)}

				{mode === "select" && (
					<div className="space-y-2">
						<button
							type="button"
							onClick={() => setMode("direct")}
							className="flex w-full items-center gap-3 rounded-xl border border-border px-4 py-4 text-left transition-colors hover:bg-surface-hover"
						>
							<div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
								<Search size={20} />
							</div>
							<div>
								<p className="font-medium text-text-primary">Direct Message</p>
								<p className="text-sm text-text-secondary">Chat with someone privately</p>
							</div>
						</button>
						<button
							type="button"
							onClick={() => setMode("group")}
							className="flex w-full items-center gap-3 rounded-xl border border-border px-4 py-4 text-left transition-colors hover:bg-surface-hover"
						>
							<div className="flex h-10 w-10 items-center justify-center rounded-full bg-success/10 text-success">
								<Users size={20} />
							</div>
							<div>
								<p className="font-medium text-text-primary">Group Chat</p>
								<p className="text-sm text-text-secondary">Create a group with multiple people</p>
							</div>
						</button>
					</div>
				)}

				{mode === "direct" && (
					<>
						<div className="relative mb-4">
							<Search
								size={16}
								className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
							/>
							<input
								type="text"
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								placeholder="Search users..."
								className={cn(
									"w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm",
									"focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary",
								)}
							/>
						</div>
						<div className="max-h-64 overflow-y-auto">
							{searchResults?.users.map((user) => (
								<button
									type="button"
									key={user.id}
									onClick={() => createDirectChat.mutate(user.id)}
									disabled={createDirectChat.isPending}
									className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-hover"
								>
									<div className="relative">
										<div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/20 text-sm font-semibold text-primary">
											{user.displayName.charAt(0).toUpperCase()}
										</div>
										{user.isOnline && (
											<div className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-surface bg-success" />
										)}
									</div>
									<div>
										<p className="font-medium text-text-primary">{user.displayName}</p>
										{user.username && (
											<p className="text-sm text-text-secondary">@{user.username}</p>
										)}
									</div>
								</button>
							))}
							{searchQuery.length >= 2 && !searchLoading && searchResults?.users.length === 0 && (
								<p className="py-8 text-center text-sm text-text-muted">No users found</p>
							)}
							{searchQuery.length < 2 && (
								<p className="py-8 text-center text-sm text-text-muted">
									Type at least 2 characters to search
								</p>
							)}
						</div>
					</>
				)}

				{mode === "group" && (
					<>
						<div className="mb-4">
							<input
								type="text"
								value={groupName}
								onChange={(e) => setGroupName(e.target.value)}
								placeholder="Group name..."
								maxLength={200}
								className={cn(
									"w-full rounded-lg border border-border bg-surface px-4 py-2.5 text-sm",
									"text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary",
								)}
							/>
						</div>

						{selectedMembers.length > 0 && (
							<div className="mb-3 flex flex-wrap gap-1.5">
								{selectedMembers.map((m) => (
									<span
										key={m.id}
										className="flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
									>
										{m.displayName}
										<button
											type="button"
											onClick={() => toggleMember(m)}
											className="rounded-full p-0.5 hover:bg-primary/20"
											aria-label={`Remove ${m.displayName}`}
										>
											<X size={12} />
										</button>
									</span>
								))}
							</div>
						)}

						<div className="relative mb-3">
							<Search
								size={16}
								className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
							/>
							<input
								type="text"
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								placeholder="Add members..."
								className={cn(
									"w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm",
									"focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary",
								)}
							/>
						</div>

						<div className="max-h-48 overflow-y-auto">
							{searchResults?.users.map((user) => (
								<button
									type="button"
									key={user.id}
									onClick={() => toggleMember(user)}
									className={cn(
										"flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-hover",
										selectedIds.has(user.id) && "bg-primary/5",
									)}
								>
									<div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/20 text-xs font-semibold text-primary">
										{user.displayName.charAt(0).toUpperCase()}
									</div>
									<div className="flex-1">
										<p className="text-sm font-medium text-text-primary">{user.displayName}</p>
									</div>
									{selectedIds.has(user.id) && <Check size={16} className="text-primary" />}
								</button>
							))}
						</div>

						{selectedMembers.length > 0 && groupName.trim() && (
							<button
								type="button"
								onClick={() => createGroupChat.mutate()}
								disabled={createGroupChat.isPending}
								className={cn(
									"mt-4 w-full rounded-lg bg-primary py-2.5 text-sm font-medium text-white",
									"hover:bg-primary-hover transition-colors",
									"disabled:opacity-50",
								)}
							>
								{createGroupChat.isPending
									? "Creating..."
									: `Create Group (${selectedMembers.length} members)`}
							</button>
						)}
					</>
				)}
			</div>
		</div>
	);
}
