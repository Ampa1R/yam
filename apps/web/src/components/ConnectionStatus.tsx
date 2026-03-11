import { WifiOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

interface Props {
	status: "connected" | "connecting" | "disconnected";
}

const CONNECTING_DELAY_MS = 5_000;

export function ConnectionStatus({ status }: Props) {
	const [showConnecting, setShowConnecting] = useState(false);

	useEffect(() => {
		if (status !== "connecting") {
			setShowConnecting(false);
			return;
		}
		const timer = setTimeout(() => setShowConnecting(true), CONNECTING_DELAY_MS);
		return () => clearTimeout(timer);
	}, [status]);

	const visible = status === "disconnected" || (status === "connecting" && showConnecting);

	return (
		<AnimatePresence>
			{visible && (
				<motion.div
					initial={{ height: 0, opacity: 0 }}
					animate={{ height: "auto", opacity: 1 }}
					exit={{ height: 0, opacity: 0 }}
					transition={{ type: "spring", damping: 25, stiffness: 300 }}
					className="overflow-hidden"
				>
					<div
						className={cn(
							"flex items-center justify-center gap-2 px-4 py-1.5 text-xs font-medium text-white",
							status === "connecting" ? "bg-yellow-500" : "bg-danger",
						)}
					>
						{status === "disconnected" && (
							<>
								<WifiOff size={12} />
								<span>Connection lost. Reconnecting...</span>
							</>
						)}
						{status === "connecting" && (
							<>
								<div className="h-3 w-3 animate-spin rounded-full border border-white border-t-transparent" />
								<span>Connecting...</span>
							</>
						)}
					</div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
