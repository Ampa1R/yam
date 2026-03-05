export class AppError extends Error {
	constructor(
		public readonly statusCode: number,
		message: string,
		public readonly code?: string,
	) {
		super(message);
		this.name = "AppError";
	}
}

export const Errors = {
	notFound: (resource: string) => new AppError(404, `${resource} not found`, "NOT_FOUND"),
	unauthorized: (message = "Unauthorized") => new AppError(401, message, "UNAUTHORIZED"),
	forbidden: (message = "Forbidden") => new AppError(403, message, "FORBIDDEN"),
	badRequest: (message: string) => new AppError(400, message, "BAD_REQUEST"),
	conflict: (message: string) => new AppError(409, message, "CONFLICT"),
	tooManyRequests: (message = "Too many requests") => new AppError(429, message, "RATE_LIMITED"),
	internal: (message = "Internal server error") => new AppError(500, message, "INTERNAL_ERROR"),
};
