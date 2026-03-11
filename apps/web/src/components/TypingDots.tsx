import { motion } from "motion/react";

export function TypingDots() {
	return (
		<span className="inline-flex items-center gap-0.5">
			<span>typing</span>
			{[0, 1, 2].map((i) => (
				<motion.span
					key={i}
					className="inline-block h-1 w-1 rounded-full bg-current"
					animate={{ y: [0, -3, 0] }}
					transition={{
						duration: 0.6,
						repeat: Infinity,
						delay: i * 0.15,
						ease: "easeInOut",
					}}
				/>
			))}
		</span>
	);
}
