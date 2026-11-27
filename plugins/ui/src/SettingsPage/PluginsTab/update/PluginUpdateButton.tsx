import React from "react";

import { LunaRegistry, type LunaPlugin, type PluginPackage } from "@luna/core";
import { ipcRenderer } from "@luna/lib";
import { useConfirm } from "material-ui-confirm";

import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import SystemUpdateAltIcon from "@mui/icons-material/SystemUpdateAlt";
import { green } from "@mui/material/colors";

import { UpdateDetails } from "../../../components";
import { useRegistry } from "../RegistryBadge";
import { PluginUpdatePermissionWarning } from "./PluginUpdatePermissionWarning";
import { pluginUpdateSource } from "./pluginUpdateSource";
import { UpdateRegistryStatus } from "./UpdateRegistryStatus";

export const PluginUpdateButton = React.memo(({ plugin }: { plugin: LunaPlugin }) => {
	const subscribe = React.useCallback((notify: () => void) => plugin.pendingUpdate.onValue(notify), [plugin]);
	const update = React.useSyncExternalStore(subscribe, () => plugin.pendingUpdate._);
	const [updating, setUpdating] = React.useState(false);
	const confirm = useConfirm();

	const onClick = React.useCallback(async () => {
		if (update === undefined) return;
		const current: Readonly<Partial<PluginPackage>> = plugin.package ?? {};
		const { git, releaseTag } = pluginUpdateSource(plugin.url, current, update);
		// Answers the user chose to revoke in the dialog ("Ask again"), revoked only if they update
		let permissionKeys: string[] = [];
		const { confirmed } = await confirm({
			title: `Update ${plugin.name}?`,
			description: (
				<UpdateDetails
					from={{ version: current.version, commit: current.commit, sha256: current.codeSha256 }}
					to={{ version: update.version, commit: update.commit, sha256: update.codeSha256 }}
					git={git}
					releaseTag={releaseTag}
					trustUrl={plugin.url}
					trustHref={`${plugin.url}.json`}
				>
					<UpdateRegistryStatus plugin={plugin} update={update} />
					<PluginUpdatePermissionWarning url={plugin.url} onRevokePermissions={(keys) => (permissionKeys = keys)} />
				</UpdateDetails>
			),
			confirmationText: "Update",
			cancellationText: "Not now",
		});
		// One revoked while the dialog was open is refused by acceptUpdate, with a message
		if (!confirmed) return;
		setUpdating(true);
		// Right before the update is applied: an update that doesn't go ahead leaves the answers, and the running version
		// keeps its native code. The first that can't be revoked stops the update (its code would run without asking);
		// those revoked before it stay revoked, so they ask again: the safe side
		const revokePermissions = async () => {
			for (const key of permissionKeys)
				await ipcRenderer
					.invoke("__Luna.nativePermissions.revoke", key)
					.catch(plugin.trace.msg.err.withContext(`Not updating ${plugin.name}: couldn't revoke its native permissions for all versions`).throw);
		};
		try {
			// The update the user was shown, even if a newer one arrived meanwhile
			await plugin.acceptUpdate(update, permissionKeys.length === 0 ? undefined : revokePermissions);
		} catch {
			// Already shown: a load error on the plugin's card, a refused (revoked) version or a failed revoke as an error message
		} finally {
			setUpdating(false);
		}
	}, [plugin, update, confirm]);

	// Re-renders when the lists or "Only verified updates" change: an update verified meanwhile becomes a button
	useRegistry();

	if (update === undefined) return null;
	if (!LunaRegistry.updateOffered(update.rawSha256, update.name ?? plugin.name))
		return (
			<Tooltip
				title={`${update.version ?? "A new version"} is not verified by the Luna plugin registry. Only verified updates are offered: turn that off above to update anyway`}
			>
				<Chip size="small" variant="outlined" color="warning" label={`Unverified update ${update.version ?? ""}`.trim()} sx={{ marginLeft: 1 }} />
			</Tooltip>
		);
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
