import React from "react";

import { LunaPlugin, type PluginPackage } from "@luna/core";
import { useConfirm } from "material-ui-confirm";

import Button from "@mui/material/Button";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import SystemUpdateAltIcon from "@mui/icons-material/SystemUpdateAlt";
import { green } from "@mui/material/colors";

/** What the update changes that the user should know about before running it */
const UpdateDetails = ({ plugin, update }: { plugin: LunaPlugin; update: PluginPackage }) => {
	const before = new Set(LunaPlugin.nativeFileNames(plugin.code ?? ""));
	const after = LunaPlugin.nativeFileNames(update.code ?? "");
	const added = after.filter((name) => !before.has(name));
	const removed = [...before].filter((name) => !after.includes(name));
	return (
		<>
			<Typography variant="body2" gutterBottom>
				<b>{plugin.package?.version ?? "?"}</b> → <b>{update.version ?? "?"}</b>
			</Typography>
			<Typography variant="body2" gutterBottom>
				Until you update, the version you have keeps running. The new code runs with the same access to TIDAL as the plugin has now. Luna doesn't
				check what it does: update only if you trust the author and {plugin.url}.
			</Typography>
			{after.length !== 0 && (
				<Typography variant="body2" gutterBottom>
					Native code (runs in TIDAL's main process): {after.join(", ")}. Changed native files ask for permission again.
				</Typography>
			)}
			{added.length !== 0 && (
				<Typography variant="body2" sx={{ color: "warning.main" }} gutterBottom>
					New native files: {added.join(", ")}
				</Typography>
			)}
			{removed.length !== 0 && <Typography variant="body2">Removed native files: {removed.join(", ")}</Typography>}
		</>
	);
};

export const PluginUpdateButton = React.memo(({ plugin }: { plugin: LunaPlugin }) => {
	const subscribe = React.useCallback((notify: () => void) => plugin.pendingUpdate.onValue(notify), [plugin]);
	const update = React.useSyncExternalStore(subscribe, () => plugin.pendingUpdate._);
	const [updating, setUpdating] = React.useState(false);
	const confirm = useConfirm();

	const onClick = React.useCallback(async () => {
		if (update === undefined) return;
		const { confirmed } = await confirm({
			title: `Update ${plugin.name}?`,
			description: <UpdateDetails plugin={plugin} update={update} />,
			confirmationText: "Update",
			cancellationText: "Not now",
		});
		if (!confirmed) return;
		setUpdating(true);
		try {
			// The update the user was shown, even if a newer one arrived meanwhile
			await plugin.acceptUpdate(update);
		} catch {
			// The plugin shows its load error on its card
		} finally {
			setUpdating(false);
		}
	}, [plugin, update, confirm]);

	if (update === undefined) return null;
	return (
		<Tooltip title={`Update to ${update.version ?? "a new version"}`}>
			<span>
				<Button
					size="small"
					variant="outlined"
					disabled={updating}
					onClick={onClick}
					startIcon={<SystemUpdateAltIcon />}
					sx={{ marginLeft: 1, color: green[400], borderColor: green[400] }}
				>
					Update
				</Button>
			</span>
		</Tooltip>
	);
});
