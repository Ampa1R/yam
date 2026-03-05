import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChatType } from "@yam/shared";
import { MessageCircle, Search, Trash2, UserPlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useChatStore } from "@/stores/chat";

interface Contact {
	userId: string;
	contactId: string;
	nickname: string | null;
	user: {
		id: string;
		displayName: string;
		username: string | null;
		avatarUrl: string | null;
		statusText: string | null;
		isOnline: boolean;
		lastSeen: string | null;
	};
}

interface Props {
	onClose: () => void;
}

export function ContactsDialog({ onClose }: Props) {
	const [tab, setTab] = useState<"contacts" | "add">("contacts");
	const [searchQuery, setSearchQuery] = useState("");
	const { setActiveChatId } = useChatStore();
	const queryClient = useQueryClient();

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	const { data: contactsData } = useQuery({
		queryKey: ["contacts"],
		queryFn: () => api.get<{ contacts: Contact[] }>("/contacts"),
	});

	const { data: searchResults, isLoading: searchLoading } = useQuery({
		queryKey: ["user-search-contacts", searchQuery],
		queryFn: () =>
			api.get<{
				users: {
					id: string;
					displayName: string;
					username: string | null;
					avatarUrl: string | null;
					isOnline: boolean;
				}[];
			}>(`/users/search?q=${encodeURIComponent(searchQuery)}`),
		enabled: tab === "add" && searchQuery.length >= 2,
	});

	const addContact = useMutation({
		mutationFn: (userId: string) => api.post("/contacts", { userId }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["contacts"] });
		},
	});

	const removeContact = useMutation({
		mutationFn: (contactId: string) => api.delete(`/contacts/${contactId}`),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["contacts"] });
		},
	});

	const startChat = useMutation({
		mutationFn: (userId: string) =>
			api.post<{ chat: { id: string } }>("/chats", {
				type: ChatType.DIRECT,
				memberIds: [userId],
			}),
		onSuccess: (data) => {
			setActiveChatId(data.chat.id);
			queryClient.invalidateQueries({ queryKey: ["inbox"] });
			onClose();
		},
	});

	const contactIds = new Set(contactsData?.contacts.map((c) => c.contactId) ?? []);

	const error = addContact.error || removeContact.error || startChat.error;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
			<div className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
				<div className="mb-4 flex items-center justify-between">
					<h2 className="text-lg font-semibold text-text-primary">Contacts</h2>
					<button type="button" onClick={onClose} className="rounded-lg p-1 hover:bg-surface-hover" aria-label="Close">
						<X size={20} className="text-text-secondary" />
					</button>
				</div>

				{error && (
					<div className="mb-3 rounded-lg bg-danger/10 px-4 py-2 text-sm text-danger">
						{error instanceof Error ? error.message : "An error occurred"}
					</div>
				)}

				<div className="mb-4 flex gap-1 rounded-lg bg-surface-secondary p-1">
					<button
						type="button"
						onClick={() => setTab("contacts")}
						className={cn(
							"flex-1 rounded-md py-1.5 text-sm font-medium transition-colors",
							tab === "contacts"
								? "bg-surface text-text-primary shadow-sm"
								: "text-text-secondary hover:text-text-primary",
						)}
					>
						My Contacts ({contactsData?.contacts.length ?? 0})
					</button>
					<button
						type="button"
						onClick={() => setTab("add")}
						className={cn(
							"flex-1 rounded-md py-1.5 text-sm font-medium transition-colors",
							tab === "add"
								? "bg-surface text-text-primary shadow-sm"
								: "text-text-secondary hover:text-text-primary",
						)}
					>
						Add Contact
					</button>
				</div>

				{tab === "add" && (
					<div className="relative mb-4">
						<Search
							size={16}
							className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
						/>
						<input
							type="text"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							placeholder="Search by name, username, or phone..."
							className={cn(
								"w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm",
								"focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary",
							)}
						/>
					</div>
				)}

				<div className="max-h-80 overflow-y-auto">
					{tab === "contacts" &&
						((contactsData?.contacts ?? []).length === 0 ? (
							<div className="py-12 text-center">
								<UserPlus size={40} strokeWidth={1} className="mx-auto text-text-muted" />
								<p className="mt-3 text-sm text-text-muted">No contacts yet</p>
								<button
									type="button"
									onClick={() => setTab("add")}
									className="mt-2 text-sm text-primary hover:underline"
								>
									Find people
								</button>
							</div>
						) : (
							contactsData?.contacts.map((contact) => (
								<div
									key={contact.contactId}
									className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-hover"
								>
									<div className="relative">
										<div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/20 text-sm font-semibold text-primary">
											{contact.user.displayName.charAt(0).toUpperCase()}
										</div>
										{contact.user.isOnline && (
											<div className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-surface bg-success" />
										)}
									</div>
									<div className="min-w-0 flex-1">
										<p className="truncate text-sm font-medium text-text-primary">
											{contact.user.displayName}
										</p>
										{contact.user.username && (
											<p className="truncate text-xs text-text-secondary">
												@{contact.user.username}
											</p>
										)}
									</div>
									<div className="flex gap-1">
										<button
											type="button"
											onClick={() => startChat.mutate(contact.contactId)}
											disabled={startChat.isPending}
											className="rounded-lg p-1.5 text-text-secondary hover:bg-primary/10 hover:text-primary"
											title="Message"
											aria-label={`Message ${contact.user.displayName}`}
										>
											<MessageCircle size={16} />
										</button>
										<button
											type="button"
											onClick={() => removeContact.mutate(contact.contactId)}
											disabled={removeContact.isPending}
											className="rounded-lg p-1.5 text-text-secondary hover:bg-danger/10 hover:text-danger"
											title="Remove"
											aria-label={`Remove ${contact.user.displayName}`}
										>
											<Trash2 size={16} />
										</button>
									</div>
								</div>
							))
						))}

					{tab === "add" && (
						<>
							{searchQuery.length >= 2 &&
								searchResults?.users.map((u) => (
									<div
										key={u.id}
										className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-hover"
									>
										<div className="relative">
											<div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/20 text-sm font-semibold text-primary">
												{u.displayName.charAt(0).toUpperCase()}
											</div>
											{u.isOnline && (
												<div className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-surface bg-success" />
											)}
										</div>
										<div className="min-w-0 flex-1">
											<p className="truncate text-sm font-medium text-text-primary">
												{u.displayName}
											</p>
											{u.username && (
												<p className="truncate text-xs text-text-secondary">@{u.username}</p>
											)}
										</div>
										{contactIds.has(u.id) ? (
											<span className="text-xs text-text-muted">Added</span>
										) : (
											<button
												type="button"
												onClick={() => addContact.mutate(u.id)}
												disabled={addContact.isPending}
												className="flex items-center gap-1 rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20"
											>
												<UserPlus size={14} />
												Add
											</button>
										)}
									</div>
								))}
							{searchQuery.length >= 2 && !searchLoading && searchResults?.users.length === 0 && (
								<p className="py-8 text-center text-sm text-text-muted">No users found</p>
							)}
							{searchQuery.length < 2 && (
								<p className="py-8 text-center text-sm text-text-muted">
									Type at least 2 characters to search
								</p>
							)}
						</>
					)}
				</div>
			</div>
		</div>
	);
}
