import React from "react";

import { LunaPlugin } from "@luna/core";

import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import SystemUpdateAltIcon from "@mui/icons-material/SystemUpdateAlt";
import { green } from "@mui/material/colors";

export const PluginUpdateButton = React.memo(({ plugin }: { plugin: LunaPlugin }) => {
	const subscribe = React.useCallback((notify: () => void) => plugin.pendingUpdate.onValue(notify), [plugin]);
	const update = React.useSyncExternalStore(subscribe, () => plugin.pendingUpdate._);
	const [updating, setUpdating] = React.useState(false);

	const onClick = React.useCallback(async () => {
		setUpdating(true);
		try {
			// Luna core shows what the update changes and asks the user, in its own window
			await plugin.acceptUpdate();
		} catch {
			// The plugin shows its load error on its card
		} finally {
			setUpdating(false);
		}
	}, [plugin]);

	if (update === undefined) return null;
	return (
		<Tooltip title={`Update plugin${update.version === undefined ? "" : ` to ${update.version}`}`}>
			<span>
				<IconButton aria-label={`Update ${plugin.name}`} disabled={updating} onClick={onClick} sx={{ color: green[400] }}>
					<SystemUpdateAltIcon />
				</IconButton>
			</span>
		</Tooltip>
	);
});
