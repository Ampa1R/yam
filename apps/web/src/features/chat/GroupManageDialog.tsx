import * as Dialog from "@radix-ui/react-dialog";
import { Crown, Shield, UserMinus, UserPlus, X } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "@/components/Toast";
import { api, eden } from "@/lib/api";
import { queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/cn";

interface Member {
	userId: string;
	role: number;
	user: {
		id: string;
		displayName: string;
		username: string | null;
		avatarUrl: string | null;
	};
}

interface Props {
	chatId: string;
	chatName: string | null;
	members: Member[];
	myRole: number;
	myUserId: string;
	onClose: () => void;
}

const ROLE_LABELS: Record<number, string> = { 0: "Member", 1: "Admin", 2: "Owner" };

export function GroupManageDialog({ chatId, chatName, members, myRole, myUserId, onClose }: Props) {
	const [search, setSearch] = useState("");
	const [searchResults, setSearchResults] = useState<{ id: string; displayName: string; username: string | null; avatarUrl: string | null }[]>([]);
	const [showAddMember, setShowAddMember] = useState(false);
	const [loading, setLoading] = useState(false);

	const isAdmin = myRole >= 1;
	const isOwner = myRole >= 2;
	const memberIds = new Set(members.map((m) => m.userId));

	const handleSearch = useCallback(async (q: string) => {
		setSearch(q);
		if (q.length < 2) { setSearchResults([]); return; }
		try {
			const data = await eden(api.api.users.search.get({ query: { q } }));
			setSearchResults((data as { users: typeof searchResults }).users.filter((u) => !memberIds.has(u.id)));
		} catch { setSearchResults([]); }
	}, [memberIds]);

	const addMember = useCallback(async (userId: string) => {
		setLoading(true);
		try {
			await eden(api.api.chats({ id: chatId }).members.post({ userId }));
			toast({ title: "Member added", variant: "success" });
			void queryClient.invalidateQueries({ queryKey: ["chat", chatId] });
			setShowAddMember(false);
			setSearch("");
			setSearchResults([]);
		} catch {
			toast({ title: "Failed to add member", variant: "error" });
		} finally { setLoading(false); }
	}, [chatId]);

	const removeMember = useCallback(async (userId: string) => {
		if (!confirm("Remove this member from the group?")) return;
		try {
			await eden(api.api.chats({ id: chatId }).members({ memberId: userId }).delete());
			toast({ title: "Member removed", variant: "success" });
			void queryClient.invalidateQueries({ queryKey: ["chat", chatId] });
		} catch {
			toast({ title: "Failed to remove member", variant: "error" });
		}
	}, [chatId]);

	const changeRole = useCallback(async (userId: string, newRole: number) => {
		try {
			await eden(api.api.chats({ id: chatId }).members({ memberId: userId }).role.patch({ role: newRole }));
			toast({ title: `Role updated to ${ROLE_LABELS[newRole]}`, variant: "success" });
			void queryClient.invalidateQueries({ queryKey: ["chat", chatId] });
		} catch {
			toast({ title: "Failed to change role", variant: "error" });
		}
	}, [chatId]);

	const transferOwnership = useCallback(async (userId: string) => {
		if (!confirm("Transfer ownership? You will become an admin.")) return;
		try {
			await eden(api.api.chats({ id: chatId }).transfer.post({ userId }));
			toast({ title: "Ownership transferred", variant: "success" });
			void queryClient.invalidateQueries({ queryKey: ["chat", chatId] });
		} catch {
			toast({ title: "Failed to transfer ownership", variant: "error" });
		}
	}, [chatId]);

	const sortedMembers = [...members].sort((a, b) => b.role - a.role);

	return (
		<Dialog.Root open onOpenChange={(open) => !open && onClose()}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-surface shadow-xl">
					<div className="flex items-center justify-between border-b border-border px-5 py-4">
						<Dialog.Title className="text-lg font-semibold text-text-primary">
							{chatName ?? "Group"} — Members
						</Dialog.Title>
						<Dialog.Close className="rounded-lg p-1 text-text-muted hover:bg-surface-hover">
							<X size={18} />
						</Dialog.Close>
					</div>

					<div className="flex-1 overflow-y-auto p-4">
						{isAdmin && (
							<button
								type="button"
								onClick={() => setShowAddMember(!showAddMember)}
								className="mb-3 flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-sm text-primary hover:bg-primary/5"
							>
								<UserPlus size={16} />
								Add member
							</button>
						)}

						{showAddMember && (
							<div className="mb-4 rounded-lg border border-border bg-surface-secondary p-3">
								<input
									type="text"
									value={search}
									onChange={(e) => handleSearch(e.target.value)}
									placeholder="Search by name or username..."
									className="w-full rounded-lg border-none bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
								/>
								{searchResults.length > 0 && (
									<div className="mt-2 max-h-40 overflow-y-auto">
										{searchResults.map((u) => (
											<button
												key={u.id}
												type="button"
												disabled={loading}
												onClick={() => addMember(u.id)}
												className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-hover disabled:opacity-50"
											>
												<div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/20 text-xs font-semibold text-primary">
													{u.displayName.charAt(0).toUpperCase()}
												</div>
												<div>
													<p className="font-medium text-text-primary">{u.displayName}</p>
													{u.username && <p className="text-xs text-text-muted">@{u.username}</p>}
												</div>
											</button>
										))}
									</div>
								)}
							</div>
						)}

						<div className="space-y-1">
							{sortedMembers.map((m) => {
								const isMe = m.userId === myUserId;
								const canManage = !isMe && isAdmin && m.role < myRole;
								return (
									<div
										key={m.userId}
										className="group flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-hover"
									>
										<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/20 text-sm font-semibold text-primary">
											{m.user.displayName.charAt(0).toUpperCase()}
										</div>
										<div className="min-w-0 flex-1">
											<p className="truncate font-medium text-text-primary">
												{m.user.displayName}
												{isMe && <span className="ml-1 text-xs text-text-muted">(you)</span>}
											</p>
											<div className="flex items-center gap-1.5">
												{m.role === 2 && <Crown size={12} className="text-warning" />}
												{m.role === 1 && <Shield size={12} className="text-primary" />}
												<span className="text-xs text-text-muted">{ROLE_LABELS[m.role] ?? "Member"}</span>
												{m.user.username && (
													<span className="text-xs text-text-muted">• @{m.user.username}</span>
												)}
											</div>
										</div>
										{canManage && (
											<div className={cn("flex items-center gap-1 lg:opacity-0 lg:group-hover:opacity-100")}>
												{isOwner && m.role === 0 && (
													<button
														type="button"
														onClick={() => changeRole(m.userId, 1)}
														className="rounded p-1.5 text-text-muted hover:bg-primary/10 hover:text-primary"
														title="Promote to admin"
													>
														<Shield size={14} />
													</button>
												)}
												{isOwner && m.role === 1 && (
													<button
														type="button"
														onClick={() => changeRole(m.userId, 0)}
														className="rounded p-1.5 text-text-muted hover:bg-surface-hover hover:text-text-primary"
														title="Demote to member"
													>
														<Shield size={14} className="opacity-40" />
													</button>
												)}
												{isOwner && (
													<button
														type="button"
														onClick={() => transferOwnership(m.userId)}
														className="rounded p-1.5 text-text-muted hover:bg-warning/10 hover:text-warning"
														title="Transfer ownership"
													>
														<Crown size={14} />
													</button>
												)}
												<button
													type="button"
													onClick={() => removeMember(m.userId)}
													className="rounded p-1.5 text-text-muted hover:bg-danger/10 hover:text-danger"
													title="Remove member"
												>
													<UserMinus size={14} />
												</button>
											</div>
										)}
									</div>
								);
							})}
						</div>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
