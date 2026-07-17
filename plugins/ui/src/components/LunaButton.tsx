import React from "react";

import Button, { type ButtonProps } from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";

export type LunaButtonProps = ButtonProps & {
	tooltip?: string;
};

export const LunaButton = React.memo((props: LunaButtonProps) => {
	const title = props.tooltip ?? props.title ?? (typeof props.children === "string" ? props.children : undefined);
	return (
		<Tooltip sx={{ marginRight: "auto" }} title={title}>
			<Button
				loadingIndicator={<CircularProgress color="warning" size={16} />}
				variant={props.variant ?? "contained"}
				children={props.children}
				{...props}
			/>
		</Tooltip>
	);
});
