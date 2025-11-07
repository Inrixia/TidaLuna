import React from "react";

import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Switch from "@mui/material/Switch";

import { useTheme } from "@mui/material";
import type { SwitchProps } from "@mui/material/Switch";
import Tooltip from "@mui/material/Tooltip";

const LoadingIcon = React.memo(({ checked, loading }: { checked?: boolean; loading?: boolean }) => {
	const theme = useTheme();
	const color = checked ? theme.palette.text.primary : theme.palette.text.secondary;
	const backgroundColor = checked ? "#000" : theme.palette.text.primary;
	return (
		<Box
			style={{
				borderRadius: 12,
				marginTop: 2,
				marginLeft: 2,
				width: 16,
				height: 16,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				backgroundColor: backgroundColor,
			}}
		>
			{loading && <CircularProgress size={12} thickness={4} style={{ color }} />}
		</Box>
	);
});

export interface LunaSwitchProps extends Omit<SwitchProps, "title"> {
	loading?: boolean;
	tooltip?: string;
}
export const LunaSwitch = React.memo((props: LunaSwitchProps) => {
	const { tooltip, loading, ...switchProps } = props;
	return (
		<Tooltip
			sx={{
				marginRight: "auto",
			}}
			title={tooltip}
		>
			<Switch
			  disabled={loading}
				icon={<LoadingIcon loading={loading} />}
				checkedIcon={<LoadingIcon checked loading={loading} />}
				{...switchProps}
				sx={{ marginLeft: "auto", ...switchProps.sx }}
			/>
		</Tooltip>
	);
});
