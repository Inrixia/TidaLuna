import { unloadSet, type LunaPlugin } from "@luna/core";

import SensorsIcon from "@mui/icons-material/Sensors";
import SensorsOffIcon from "@mui/icons-material/SensorsOff";
import type { IconButtonProps } from "@mui/material/IconButton";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import React from "react";

export interface LiveReloadToggleButtonProps extends IconButtonProps {
	checked?: boolean;
	plugin: LunaPlugin;
}

export const LiveReloadToggle = React.memo((props: LiveReloadToggleButtonProps) => {
	const { plugin, ...iconButtonProps } = props;
	const [fetching, setFetching] = React.useState(plugin.fetching._);
	const [liveReload, setLiveReload] = React.useState(plugin.liveReload);

	React.useEffect(() => {
		const unloads = new Set([plugin.fetching.onValue(setFetching), plugin.onSetLiveReload(setLiveReload)]);
		return () => {
			unloadSet(unloads);
		};
	}, [plugin.fetching, plugin.onSetLiveReload]);

	const [animate, setAnimate] = React.useState(plugin.fetching._);

	React.useEffect(() => {
		let timeoutId: NodeJS.Timeout | undefined;
		if (fetching && !animate) setAnimate(true);
		else if (!fetching && animate) timeoutId = setTimeout(() => setAnimate(false), 500);
		return () => clearTimeout(timeoutId);
	}, [fetching, animate]);

	const handleClick = React.useCallback(() => {
		plugin.liveReload = !plugin.liveReload;
	}, [plugin]);

	return (
		<Tooltip title={liveReload ? "Disable live reloading" : "Enable live reloading (for development)"}>
			<IconButton
				{...iconButtonProps}
				onClick={handleClick}
				color={props.plugin.liveReload ? "success" : "error"}
				sx={{
					animation: animate ? "vibrate 0.25s linear infinite" : "none",
					"@keyframes vibrate": {
						"0%": { transform: "rotate(0deg) scale(1)" },
						"20%": { transform: "rotate(-4deg) scale(0.9)" },
						"40%": { transform: "rotate(0deg) scale(1)" },
						"60%": { transform: "rotate(4deg) scale(1.1)" },
						"100%": { transform: "rotate(0deg) scale(1)" },
					},
				}}
			>
				{props.plugin.liveReload ? <SensorsIcon /> : <SensorsOffIcon />}
			</IconButton>
		</Tooltip>
	);
});
