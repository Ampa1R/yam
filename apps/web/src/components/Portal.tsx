import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
	children: ReactNode;
}

export function Portal({ children }: Props) {
	const [container, setContainer] = useState<HTMLElement | null>(null);

	useEffect(() => {
		const el = document.createElement("div");
		el.setAttribute("data-portal", "");
		document.body.appendChild(el);
		setContainer(el);
		return () => {
			document.body.removeChild(el);
		};
	}, []);

	if (!container) return null;
	return createPortal(children, container);
}
