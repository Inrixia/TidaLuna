import CachedIcon from "@mui/icons-material/Cached";
import IconButton, { type IconButtonProps } from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";

import React, { useEffect, useState } from "react";

interface SpinningButtonProps extends IconButtonProps {
	spin?: boolean;
	title?: string;
	icon?: React.ElementType; // Allow MUI icons or other components accepting sx
	sxColor?: string;
}

export const SpinningButton = ({ spin, ...props }: SpinningButtonProps) => {
	const [isSpinning, setIsSpinning] = useState(false);

	useEffect(() => {
		let timeoutId: NodeJS.Timeout | undefined;

		if (spin) {
			setIsSpinning(true);
		} else if (isSpinning) {
			timeoutId = setTimeout(() => setIsSpinning(false), 500);
		}
		return () => clearTimeout(timeoutId);
	}, [spin, isSpinning]);

	const animationSx = {
		...props.sx,
		color: props.disabled ? undefined : props.sxColor,
		animation: isSpinning ? "spin 0.5s linear infinite" : "none",
		"@keyframes spin": {
			"0%": { transform: "rotate(0deg)" },
			"100%": { transform: "rotate(360deg)" },
		},
	};

	return (
		<Tooltip
			title={props.title}
			children={
				<IconButton
					color="warning"
					{...props}
					onClick={(...args) => {
						setIsSpinning(true);
						props.onClick?.(...args);
					}}
					children={props.icon ? <props.icon sx={animationSx} /> : <CachedIcon sx={animationSx} />}
				/>
			}
		/>
	);
};
