import { useCallback, useEffect, useRef } from "react";

export function useThrottleCallback<T extends (...args: never[]) => void>(
	fn: T,
	delayMs: number,
): T {
	const lastRun = useRef(0);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
				timeoutRef.current = null;
			}
		};
	}, []);

	return useCallback(
		((...args: Parameters<T>) => {
			const now = Date.now();
			const remaining = delayMs - (now - lastRun.current);

			if (remaining <= 0) {
				lastRun.current = now;
				fn(...args);
			} else if (!timeoutRef.current) {
				timeoutRef.current = setTimeout(() => {
					lastRun.current = Date.now();
					timeoutRef.current = null;
					fn(...args);
				}, remaining);
			}
		}) as T,
		[fn, delayMs],
	);
}
