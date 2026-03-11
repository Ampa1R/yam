import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./components/Toast";
import { queryClient } from "./lib/queryClient";
import "./index.css";

window.addEventListener("unhandledrejection", (event) => {
	console.error("[UnhandledPromiseRejection]", event.reason);
});

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ErrorBoundary>
			<QueryClientProvider client={queryClient}>
				<ToastProvider>
					<BrowserRouter>
						<App />
					</BrowserRouter>
				</ToastProvider>
			</QueryClientProvider>
		</ErrorBoundary>
	</StrictMode>,
);
