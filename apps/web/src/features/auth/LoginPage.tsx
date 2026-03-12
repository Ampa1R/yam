import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, eden } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useAuthStore } from "@/stores/auth";

const PHONE_REGEX = /^\+\d{10,15}$/;

export function LoginPage() {
	const [step, setStep] = useState<"phone" | "otp">("phone");
	const [phone, setPhone] = useState("");
	const [code, setCode] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const navigate = useNavigate();
	const { setUser, setTokens } = useAuthStore();

	const handlePhoneChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const value = e.target.value.replace(/[^\d+]/g, "");
		if (value.length <= 16) setPhone(value);
	}, []);

	const handleRequestOtp = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");

		if (!PHONE_REGEX.test(phone)) {
			setError("Enter a valid phone number (e.g. +79001234567)");
			return;
		}

		setLoading(true);
		try {
			await eden(api.api.auth["request-otp"].post({ phone }));
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

		if (code.length !== 6) {
			setError("Code must be 6 digits");
			return;
		}

		setLoading(true);
		try {
			const raw = await eden(api.api.auth["verify-otp"].post({ phone, code }));
			const res = raw as {
				accessToken: string;
				refreshToken: string;
				user: Parameters<typeof setUser>[0];
			};
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
							<label
								htmlFor="phone-input"
								className="mb-1 block text-sm font-medium text-text-secondary"
							>
								Phone Number
							</label>
							<input
								id="phone-input"
								type="tel"
								inputMode="tel"
								autoComplete="tel"
								value={phone}
								onChange={handlePhoneChange}
								placeholder="+79001234567"
								className={cn(
									"w-full rounded-lg border border-border bg-surface px-4 py-3",
									"text-text-primary placeholder:text-text-muted",
									"focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary",
								)}
								required
							/>
						</div>
						{error && (
							<p className="text-sm text-danger" role="alert">
								{error}
							</p>
						)}
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
							Demo phones: +79000000001 to +79000000009 (code: 000000)
						</p>
					</form>
				) : (
					<form onSubmit={handleVerifyOtp} className="space-y-4">
						<div>
							<label
								htmlFor="otp-input"
								className="mb-1 block text-sm font-medium text-text-secondary"
							>
								Verification Code
							</label>
							<input
								id="otp-input"
								ref={(el) => el?.focus()}
								type="text"
								inputMode="numeric"
								autoComplete="one-time-code"
								value={code}
								onChange={(e) => {
									const v = e.target.value.replace(/\D/g, "");
									if (v.length <= 6) setCode(v);
								}}
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
						{error && (
							<p className="text-sm text-danger" role="alert">
								{error}
							</p>
						)}
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
