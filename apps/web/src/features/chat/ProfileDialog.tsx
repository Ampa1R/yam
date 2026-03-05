import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { User } from "@yam/shared";
import { Camera, Check, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Portal } from "@/components/Portal";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useAuthStore } from "@/stores/auth";

interface Props {
	onClose: () => void;
}

export function ProfileDialog({ onClose }: Props) {
	const { user, setUser } = useAuthStore();
	const queryClient = useQueryClient();
	const [displayName, setDisplayName] = useState(user?.displayName ?? "");
	const [username, setUsername] = useState(user?.username ?? "");
	const [statusText, setStatusText] = useState(user?.statusText ?? "");
	const [isProfilePublic, setIsProfilePublic] = useState(
		user?.isProfilePublic ?? false,
	);
	const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
	const avatarInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (user) {
			setDisplayName(user.displayName ?? "");
			setUsername(user.username ?? "");
			setStatusText(user.statusText ?? "");
			setIsProfilePublic(user.isProfilePublic ?? false);
		}
	}, [user]);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	useEffect(() => {
		return () => {
			if (avatarPreview) URL.revokeObjectURL(avatarPreview);
		};
	}, [avatarPreview]);

	const uploadAvatar = useMutation({
		mutationFn: (file: File) =>
			api.upload<{ id: string; url: string }>("/files/upload", file),
	});

	const updateProfile = useMutation({
		mutationFn: (data: Record<string, unknown>) =>
			api.patch<User>("/users/me", data),
		onSuccess: (data) => {
			setUser(data);
			queryClient.invalidateQueries({ queryKey: ["me"] });
			onClose();
		},
	});

	const handleAvatarChange = useCallback(
		async (e: React.ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0];
			if (!file) return;

			if (!file.type.startsWith("image/")) return;
			if (file.size > 5 * 1024 * 1024) return;

			if (avatarPreview) URL.revokeObjectURL(avatarPreview);
			setAvatarPreview(URL.createObjectURL(file));

			try {
				const result = await uploadAvatar.mutateAsync(file);
				updateProfile.mutate({
					avatarUrl: result.url,
				});
			} catch {
				setAvatarPreview(null);
			}
		},
		[avatarPreview, uploadAvatar, updateProfile],
	);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		updateProfile.mutate({
			displayName: displayName || undefined,
			username: username || undefined,
			statusText: statusText || null,
			isProfilePublic,
		});
	};

	const avatarSrc = avatarPreview ?? user?.avatarUrl;

	return (
		<Portal>
			<div
				className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
				onClick={onClose}
				role="dialog"
				aria-modal="true"
				aria-label="Edit profile"
			>
				<div
					className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-xl"
					onClick={(e) => e.stopPropagation()}
				>
					<div className="mb-6 flex items-center justify-between">
						<h2 className="text-lg font-semibold text-text-primary">
							Edit Profile
						</h2>
						<button
							type="button"
							onClick={onClose}
							className="rounded-lg p-1 hover:bg-surface-hover"
							aria-label="Close"
						>
							<X size={20} className="text-text-secondary" />
						</button>
					</div>

					<div className="mb-6 flex justify-center">
						<div className="relative">
							{avatarSrc ? (
								<img
									src={avatarSrc}
									alt="Avatar"
									className="h-20 w-20 rounded-full object-cover"
								/>
							) : (
								<div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary text-2xl font-bold text-white">
									{displayName.charAt(0)?.toUpperCase() ??
										"U"}
								</div>
							)}
							<input
								ref={avatarInputRef}
								type="file"
								accept="image/jpeg,image/png,image/webp"
								className="hidden"
								onChange={handleAvatarChange}
							/>
							<button
								type="button"
								onClick={() =>
									avatarInputRef.current?.click()
								}
								disabled={uploadAvatar.isPending}
								className={cn(
									"absolute bottom-0 right-0 flex h-7 w-7 items-center justify-center rounded-full bg-primary text-white shadow-md",
									uploadAvatar.isPending && "opacity-50",
								)}
								aria-label="Change avatar"
							>
								{uploadAvatar.isPending ? (
									<div className="h-3 w-3 animate-spin rounded-full border border-white border-t-transparent" />
								) : (
									<Camera size={14} />
								)}
							</button>
						</div>
					</div>

					{(updateProfile.isError || uploadAvatar.isError) && (
						<div className="mb-4 rounded-lg bg-danger/10 px-4 py-2 text-sm text-danger">
							{updateProfile.error instanceof Error
								? updateProfile.error.message
								: uploadAvatar.error instanceof Error
									? uploadAvatar.error.message
									: "Failed to update profile"}
						</div>
					)}

					<form onSubmit={handleSubmit} className="space-y-4">
						<div>
							<label
								htmlFor="profile-display-name"
								className="mb-1 block text-sm font-medium text-text-secondary"
							>
								Display Name
							</label>
							<input
								id="profile-display-name"
								type="text"
								value={displayName}
								onChange={(e) =>
									setDisplayName(e.target.value)
								}
								maxLength={100}
								className={cn(
									"w-full rounded-lg border border-border bg-surface px-4 py-2.5 text-sm",
									"text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary",
								)}
							/>
						</div>

						<div>
							<label
								htmlFor="profile-username"
								className="mb-1 block text-sm font-medium text-text-secondary"
							>
								Username
							</label>
							<div className="relative">
								<span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-text-muted">
									@
								</span>
								<input
									id="profile-username"
									type="text"
									value={username}
									onChange={(e) =>
										setUsername(
											e.target.value.replace(
												/[^a-zA-Z0-9_]/g,
												"",
											),
										)
									}
									maxLength={50}
									className={cn(
										"w-full rounded-lg border border-border bg-surface py-2.5 pl-7 pr-4 text-sm",
										"text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary",
									)}
									placeholder="username"
								/>
							</div>
						</div>

						<div>
							<label
								htmlFor="profile-status"
								className="mb-1 block text-sm font-medium text-text-secondary"
							>
								Status
							</label>
							<input
								id="profile-status"
								type="text"
								value={statusText}
								onChange={(e) =>
									setStatusText(e.target.value)
								}
								maxLength={200}
								placeholder="What's on your mind?"
								className={cn(
									"w-full rounded-lg border border-border bg-surface px-4 py-2.5 text-sm",
									"text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary",
								)}
							/>
						</div>

						<div className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
							<div>
								<p className="text-sm font-medium text-text-primary">
									Public Profile
								</p>
								<p className="text-xs text-text-secondary">
									Others can see your avatar and status
								</p>
							</div>
							<button
								type="button"
								onClick={() =>
									setIsProfilePublic(!isProfilePublic)
								}
								role="switch"
								aria-checked={isProfilePublic}
								className={cn(
									"relative h-6 w-11 rounded-full transition-colors",
									isProfilePublic
										? "bg-primary"
										: "bg-border",
								)}
							>
								<span
									className={cn(
										"absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
										isProfilePublic
											? "left-[22px]"
											: "left-0.5",
									)}
								/>
							</button>
						</div>

						<div className="flex gap-3 pt-2">
							<button
								type="button"
								onClick={onClose}
								className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-text-secondary hover:bg-surface-hover"
							>
								Cancel
							</button>
							<button
								type="submit"
								disabled={updateProfile.isPending}
								className={cn(
									"flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white",
									"hover:bg-primary-hover transition-colors",
									"disabled:opacity-50",
								)}
							>
								<Check size={16} />
								{updateProfile.isPending
									? "Saving..."
									: "Save"}
							</button>
						</div>
					</form>
				</div>
			</div>
		</Portal>
	);
}
