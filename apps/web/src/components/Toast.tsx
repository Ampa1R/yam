import * as ToastPrimitive from "@radix-ui/react-toast";
import { X } from "lucide-react";
import { useCallback, useState } from "react";
import { cn } from "@/lib/cn";

type ToastVariant = "default" | "error" | "success";

interface ToastData {
	id: string;
	title: string;
	description?: string;
	variant: ToastVariant;
}

let addToastFn: ((toast: Omit<ToastData, "id">) => void) | null = null;

export function toast(data: Omit<ToastData, "id">) {
	addToastFn?.(data);
}

const variantClasses: Record<ToastVariant, string> = {
	default: "border-border bg-surface",
	error: "border-danger/30 bg-danger/5",
	success: "border-success/30 bg-success/5",
};

const titleClasses: Record<ToastVariant, string> = {
	default: "text-text-primary",
	error: "text-danger",
	success: "text-success",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
	const [toasts, setToasts] = useState<ToastData[]>([]);

	addToastFn = useCallback((data: Omit<ToastData, "id">) => {
		setToasts((prev) => [...prev, { ...data, id: crypto.randomUUID() }]);
	}, []);

	const handleOpenChange = useCallback((id: string, open: boolean) => {
		if (!open) {
			setToasts((prev) => prev.filter((t) => t.id !== id));
		}
	}, []);

	return (
		<ToastPrimitive.Provider swipeDirection="right" duration={5000}>
			{children}
			{toasts.map((t) => (
				<ToastPrimitive.Root
					key={t.id}
					open
					onOpenChange={(open) => handleOpenChange(t.id, open)}
					className={cn(
						"rounded-lg border px-4 py-3 shadow-lg",
						"data-[state=open]:animate-[slide-in-from-right_200ms_ease-out]",
						"data-[state=closed]:animate-[slide-out-to-right_150ms_ease-in]",
						"data-[swipe=move]:translate-x-(--radix-toast-swipe-move-x)",
						"data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform",
						"data-[swipe=end]:animate-[slide-out-to-right_150ms_ease-in]",
						variantClasses[t.variant],
					)}
				>
					<div className="flex items-start gap-3">
						<div className="min-w-0 flex-1">
							<ToastPrimitive.Title className={cn("text-sm font-medium", titleClasses[t.variant])}>
								{t.title}
							</ToastPrimitive.Title>
							{t.description && (
								<ToastPrimitive.Description className="mt-1 text-xs text-text-secondary">
									{t.description}
								</ToastPrimitive.Description>
							)}
						</div>
						<ToastPrimitive.Close
							className="rounded p-1 text-text-muted hover:bg-surface-hover hover:text-text-primary"
							aria-label="Dismiss"
						>
							<X size={14} />
						</ToastPrimitive.Close>
					</div>
				</ToastPrimitive.Root>
			))}
			<ToastPrimitive.Viewport className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2" />
		</ToastPrimitive.Provider>
	);
}
