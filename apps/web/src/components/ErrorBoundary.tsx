import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
	children: ReactNode;
	fallback?: ReactNode;
}

interface State {
	hasError: boolean;
	error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = { hasError: false, error: null };
	}

	static getDerivedStateFromError(error: Error): State {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo) {
		console.error("[ErrorBoundary] Uncaught error:", error, errorInfo);
	}

	render() {
		if (this.state.hasError) {
			if (this.props.fallback) return this.props.fallback;

			return (
				<div className="flex min-h-screen items-center justify-center bg-surface-secondary">
					<div className="w-full max-w-md rounded-2xl bg-surface p-8 text-center shadow-lg">
						<h1 className="text-xl font-bold text-danger">Something went wrong</h1>
						<p className="mt-2 text-sm text-text-secondary">
							{this.state.error?.message ?? "An unexpected error occurred"}
						</p>
						<button
							type="button"
							onClick={() => window.location.reload()}
							className="mt-6 rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-hover"
						>
							Reload Page
						</button>
					</div>
				</div>
			);
		}

		return this.props.children;
	}
}
