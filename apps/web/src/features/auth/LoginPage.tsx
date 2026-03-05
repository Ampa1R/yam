import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useAuthStore } from "@/stores/auth";

export function LoginPage() {
	const [step, setStep] = useState<"phone" | "otp">("phone");
	const [phone, setPhone] = useState("");
	const [code, setCode] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const navigate = useNavigate();
	const { setUser, setTokens } = useAuthStore();

	const handleRequestOtp = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");
		setLoading(true);
		try {
			await api.post("/auth/request-otp", { phone });
			setStep("otp");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to send code");
		} finally {
			setLoading(false);
		}
	};

	const handleVerifyOtp = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");
		setLoading(true);
		try {
			const res = await api.post<{
				accessToken: string;
				refreshToken: string;
				user: any;
			}>("/auth/verify-otp", { phone, code });
			setTokens(res.accessToken, res.refreshToken);
			setUser(res.user);
			navigate("/");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Invalid code");
		} finally {
			setLoading(false);
		}
	};

	return (
		<div className="flex min-h-screen items-center justify-center bg-surface-secondary">
			<div className="w-full max-w-sm rounded-2xl bg-surface p-8 shadow-lg">
				<div className="mb-8 text-center">
					<h1 className="text-3xl font-bold text-primary">YAM</h1>
					<p className="mt-2 text-sm text-text-secondary">Yet Another Messenger</p>
				</div>

				{step === "phone" ? (
					<form onSubmit={handleRequestOtp} className="space-y-4">
						<div>
							<label className="mb-1 block text-sm font-medium text-text-secondary">
								Phone Number
							</label>
							<input
								type="tel"
								value={phone}
								onChange={(e) => setPhone(e.target.value)}
								placeholder="+79001234567"
								className={cn(
									"w-full rounded-lg border border-border bg-surface px-4 py-3",
									"text-text-primary placeholder:text-text-muted",
									"focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary",
								)}
								required
							/>
						</div>
						{error && <p className="text-sm text-danger">{error}</p>}
						<button
							type="submit"
							disabled={loading}
							className={cn(
								"w-full rounded-lg bg-primary px-4 py-3 font-medium text-white",
								"hover:bg-primary-hover transition-colors",
								"disabled:opacity-50 disabled:cursor-not-allowed",
							)}
						>
							{loading ? "Sending..." : "Get Code"}
						</button>
						<p className="text-center text-xs text-text-muted">
							Demo phones: +79000000001 to +79000000005 (code: 000000)
						</p>
					</form>
				) : (
					<form onSubmit={handleVerifyOtp} className="space-y-4">
						<div>
							<label className="mb-1 block text-sm font-medium text-text-secondary">
								Verification Code
							</label>
							<input
								type="text"
								value={code}
								onChange={(e) => setCode(e.target.value)}
								placeholder="000000"
								maxLength={6}
								className={cn(
									"w-full rounded-lg border border-border bg-surface px-4 py-3 text-center text-2xl tracking-[0.5em]",
									"text-text-primary placeholder:text-text-muted",
									"focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary",
								)}
								required
							/>
						</div>
						{error && <p className="text-sm text-danger">{error}</p>}
						<button
							type="submit"
							disabled={loading}
							className={cn(
								"w-full rounded-lg bg-primary px-4 py-3 font-medium text-white",
								"hover:bg-primary-hover transition-colors",
								"disabled:opacity-50 disabled:cursor-not-allowed",
							)}
						>
							{loading ? "Verifying..." : "Verify"}
						</button>
						<button
							type="button"
							onClick={() => {
								setStep("phone");
								setCode("");
								setError("");
							}}
							className="w-full text-sm text-text-secondary hover:text-text-primary"
						>
							Change number
						</button>
					</form>
				)}
			</div>
		</div>
	);
}
