import { formatDistanceToNow } from "date-fns";
import { ArrowLeft } from "lucide-react";
import { TypingDots } from "@/components/TypingDots";
import type { ChatDetail } from "./chat-view-types";

interface Props {
	chatDetail: ChatDetail | undefined;
	displayName: string;
	isOtherOnline: boolean;
	otherPresence: { isOnline: boolean; lastSeen: string | null } | null;
	typingUserIds: string[];
	memberCount: number;
	onBack: () => void;
	onShowGroupManage: () => void;
}

export function ChatHeader({
	chatDetail,
	displayName,
	isOtherOnline,
	otherPresence,
	typingUserIds,
	memberCount,
	onBack,
	onShowGroupManage,
}: Props) {
	return (
		<header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3">
			<button
				type="button"
				onClick={onBack}
				className="rounded-lg p-1 text-text-secondary hover:bg-surface-hover lg:hidden"
				aria-label="Back to chats"
			>
				<ArrowLeft size={20} />
			</button>
			<div className="relative">
				<div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/20 font-semibold text-primary">
					{displayName.charAt(0).toUpperCase()}
				</div>
				{chatDetail?.chat?.type === 0 && isOtherOnline && (
					<div className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface bg-success" />
				)}
			</div>
			<div>
				<h2 className="font-semibold text-text-primary">{displayName}</h2>
				<p className="text-xs text-text-secondary">
					{typingUserIds.length > 0
						? <TypingDots />
						: chatDetail?.chat?.type === 0
							? isOtherOnline
								? "online"
								: otherPresence?.lastSeen
									? `last seen ${formatDistanceToNow(new Date(otherPresence.lastSeen), { addSuffix: true })}`
									: "offline"
							: <button type="button" onClick={onShowGroupManage} className="hover:underline">{memberCount} members</button>}
				</p>
			</div>
		</header>
	);
}
