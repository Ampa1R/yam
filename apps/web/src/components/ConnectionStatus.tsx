import { WifiOff } from "lucide-react";
import { cn } from "@/lib/cn";

interface Props {
	status: "connected" | "connecting" | "disconnected";
}

export function ConnectionStatus({ status }: Props) {
	if (status === "connected") return null;

	return (
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
	);
}
