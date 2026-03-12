import { useCallback, useRef, useState } from "react";
import { env } from "@/env";
import { ALLOWED_FILE_TYPES } from "@/lib/file-types";

export interface AttachmentItem {
	file: File;
	preview?: string;
	uploading: boolean;
	uploadedUrl?: string;
	uploadedId?: string;
	error?: string;
}

const MAX_FILE_SIZE = env.maxFileSizeMb * 1024 * 1024;

export function useAttachments(uploadFile: (file: File) => Promise<unknown>) {
	const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
	const [fileErrors, setFileErrors] = useState<string[]>([]);
	const previewUrlsRef = useRef<Set<string>>(new Set());

	const validateFile = useCallback((file: File): string | null => {
		if (file.size > MAX_FILE_SIZE) {
			return `File "${file.name}" exceeds ${env.maxFileSizeMb}MB limit`;
		}
		if (!ALLOWED_FILE_TYPES.has(file.type) && file.type !== "") {
			return `File type "${file.type}" is not allowed`;
		}
		return null;
	}, []);

	const handleFileSelect = useCallback(
		async (files: FileList) => {
			const validFiles: { file: File; preview?: string }[] = [];
			const errors: string[] = [];

			for (const file of Array.from(files)) {
				const error = validateFile(file);
				if (error) {
					errors.push(error);
					continue;
				}
				let preview: string | undefined;
				if (file.type.startsWith("image/")) {
					preview = URL.createObjectURL(file);
					previewUrlsRef.current.add(preview);
				}
				validFiles.push({ file, preview });
			}

			if (errors.length > 0) {
				setFileErrors(errors);
				setTimeout(() => setFileErrors([]), 5000);
			}

			if (validFiles.length === 0) return;

			const newAttachments: AttachmentItem[] = validFiles.map((v) => ({
				file: v.file,
				preview: v.preview,
				uploading: true,
			}));

			setAttachments((prev) => [...prev, ...newAttachments]);

			for (const attachment of newAttachments) {
				try {
					const result = await uploadFile(attachment.file);
					setAttachments((prev) =>
						prev.map((a) =>
							a.file === attachment.file
								? {
										...a,
										uploading: false,
										uploadedUrl: (result as { url: string; id: string }).url,
										uploadedId: (result as { url: string; id: string }).id,
									}
								: a,
						),
					);
				} catch (err) {
					setAttachments((prev) =>
						prev.map((a) =>
							a.file === attachment.file
								? {
										...a,
										uploading: false,
										error: err instanceof Error ? err.message : "Upload failed",
									}
								: a,
						),
					);
				}
			}
		},
		[validateFile, uploadFile],
	);

	const retryUpload = useCallback(
		async (file: File) => {
			setAttachments((prev) =>
				prev.map((a) => (a.file === file ? { ...a, uploading: true, error: undefined } : a)),
			);
			try {
				const result = (await uploadFile(file)) as { url: string; id: string };
				setAttachments((prev) =>
					prev.map((a) =>
						a.file === file
							? { ...a, uploading: false, uploadedUrl: result.url, uploadedId: result.id }
							: a,
					),
				);
			} catch (err) {
				setAttachments((prev) =>
					prev.map((a) =>
						a.file === file
							? {
									...a,
									uploading: false,
									error: err instanceof Error ? err.message : "Upload failed",
								}
							: a,
					),
				);
			}
		},
		[uploadFile],
	);

	const removeAttachment = useCallback((file: File) => {
		setAttachments((prev) => {
			const removed = prev.find((a) => a.file === file);
			if (removed?.preview) {
				URL.revokeObjectURL(removed.preview);
				previewUrlsRef.current.delete(removed.preview);
			}
			return prev.filter((a) => a.file !== file);
		});
	}, []);

	const clearAttachments = useCallback(() => {
		setAttachments([]);
	}, []);

	const revokeAllPreviews = useCallback(() => {
		for (const url of previewUrlsRef.current) {
			URL.revokeObjectURL(url);
		}
		previewUrlsRef.current.clear();
	}, []);

	return {
		attachments,
		fileErrors,
		handleFileSelect,
		retryUpload,
		removeAttachment,
		clearAttachments,
		revokeAllPreviews,
	};
}
