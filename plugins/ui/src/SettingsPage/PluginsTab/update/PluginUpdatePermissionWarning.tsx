import React from "react";

import { ipcRenderer } from "@luna/lib";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";

import type { NativePermissionEntry } from "../../../../../../native/NativeModule/trust";

/**
 * The plugin's native files allowed for all versions: the update's native code runs without asking. "Ask again" chooses
 * to revoke those answers when the user updates (as Luna Settings > Native permissions does), so they ask when the new
 * code loads. Not at once: that would stop the running version's native code too, also if the user doesn't update.
 */
export const PluginUpdatePermissionWarning = ({ url, onRevokePermissions }: { url: string; onRevokePermissions: (keys: string[]) => void }) => {
	const [entries, setEntries] = React.useState<NativePermissionEntry[]>([]);
	const [chosen, setChosen] = React.useState(false);
	React.useEffect(() => {
		ipcRenderer
			.invoke("__Luna.nativePermissions.list")
			.then((list: NativePermissionEntry[]) =>
				setEntries(list.filter((entry) => entry.answer === "allowUpdates" && (entry.url ?? entry.claimedUrl) === url)),
			)
			.catch(() => {});
	}, [url]);
	const askAgain = React.useCallback(() => {
		onRevokePermissions(entries.map(({ key }) => key));
		setChosen(true);
	}, [entries, onRevokePermissions]);

	if (entries.length === 0) return null;
	const files = entries.map(({ fileName }) => fileName).join(", ");
	return (
		<Alert
			severity="warning"
			sx={{ marginTop: 1 }}
			action={
				chosen ? undefined : (
					<Button color="inherit" size="small" onClick={askAgain}>
						Ask again
					</Button>
				)
			}
		>
			{chosen
				? `If you update, ${files} will ask for permission again.`
				: `Native code allowed for all versions (${files}): the update's runs without asking.`}
		</Alert>
	);
};
