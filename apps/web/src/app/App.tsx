import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuthStore } from "@/stores/auth";

const LoginPage = lazy(() =>
	import("@/features/auth/LoginPage").then((m) => ({ default: m.LoginPage })),
);
const ChatLayout = lazy(() =>
	import("@/features/chat/ChatLayout").then((m) => ({ default: m.ChatLayout })),
);

function PageLoader() {
	return (
		<div className="flex h-screen items-center justify-center bg-surface-secondary">
			<div className="text-center">
				<div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
				<p className="text-sm text-text-muted">Loading...</p>
			</div>
		</div>
	);
}

export function App() {
	const { isAuthenticated } = useAuthStore();

	return (
		<Suspense fallback={<PageLoader />}>
			<Routes>
				<Route
					path="/login"
					element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />}
				/>
				<Route
					path="/*"
					element={
						isAuthenticated ? <ChatLayout /> : <Navigate to="/login" replace />
					}
				/>
			</Routes>
		</Suspense>
	);
}
