import { Navigate, Route, Routes } from "react-router-dom";
import { LoginPage } from "@/features/auth/LoginPage";
import { ChatLayout } from "@/features/chat/ChatLayout";
import { useAuthStore } from "@/stores/auth";

export function App() {
	const { isAuthenticated } = useAuthStore();

	return (
		<Routes>
			<Route
				path="/login"
				element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />}
			/>
			<Route
				path="/*"
				element={isAuthenticated ? <ChatLayout /> : <Navigate to="/login" replace />}
			/>
		</Routes>
	);
}
