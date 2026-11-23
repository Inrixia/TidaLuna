import React from "react";

import { asSentence, LunaPlugin, type PluginPackage } from "@luna/core";
import { useConfirm } from "material-ui-confirm";

import Button from "@mui/material/Button";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import SystemUpdateAltIcon from "@mui/icons-material/SystemUpdateAlt";
import { green } from "@mui/material/colors";

import { LunaLink } from "../../components";
import { RegistryBadge, registryEntryOf, useRegistry } from "./RegistryBadge";

/** First 12 hex digits, enough to tell versions apart and compare with a published hash */
const shortHash = (sha256?: string) => (sha256 === undefined ? "?" : sha256.slice(0, 12));

/** What the plugin registry says about the new version's exact code (its raw sha256, the registry's key) */
const UpdateRegistryStatus = ({ plugin, update }: { plugin: LunaPlugin; update: PluginPackage }) => {
	// Follows the lists while the dialog is open: a revocation that arrives now shows here (and acceptUpdate refuses it)
	const { verified, status } = useRegistry();
	// The verified entry names the build: an update that renames the plugin is looked up by its new name
	const entry = registryEntryOf(plugin, update.rawSha256, update.name);
	const title = `sha256 of the ${update.version ?? "new"} .mjs (the registry's key): ${update.rawSha256 ?? "?"}`;
	if (entry?.revoked !== undefined)
		return (
			<Typography variant="body2" component="div" sx={{ color: "error.main" }} gutterBottom title={title}>
				<RegistryBadge plugin={plugin} rawSha256={update.rawSha256} name={update.name} /> The Luna plugin registry revoked this version:{" "}
				{asSentence(entry.revoked.reason)} It can't be installed.
			</Typography>
		);
	if (entry?.verified !== undefined)
		return (
			<Typography variant="body2" component="div" gutterBottom title={title}>
				<RegistryBadge plugin={plugin} rawSha256={update.rawSha256} name={update.name} /> The Luna plugin registry built this version from its source
				and reviewed it
				{entry.verified.report !== undefined && (
					<>
						: <LunaLink href={entry.verified.report}>{entry.verified.report}</LunaLink>
					</>
				)}
				.
			</Typography>
		);
	return (
		<Typography variant="body2" sx={{ color: "warning.main" }} gutterBottom title={title}>
			{verified === undefined
				? `Not checked: Luna couldn't get the plugin registry's list of verified plugins${status["verified.json"].error ? ` (${status["verified.json"].error})` : ""}, so it can't tell whether this version was verified.`
				: "Not verified: the Luna plugin registry has no entry for this version's code"}{" "}
			(sha256 <code>{shortHash(update.rawSha256)}</code>).
		</Typography>
	);
};

/** What the update changes that the user should know about before running it */
const UpdateDetails = ({ plugin, update }: { plugin: LunaPlugin; update: PluginPackage }) => {
	const { files, added, removed } = LunaPlugin.nativeFileChanges(plugin.code ?? "", update.code ?? "");
	return (
		<>
			<Typography variant="body2" gutterBottom>
				<b>{plugin.package?.version ?? "?"}</b> → <b>{update.version ?? "?"}</b>
			</Typography>
			<Typography variant="body2" gutterBottom title={`sha256 ${plugin.package?.codeSha256 ?? "?"} → ${update.codeSha256 ?? "?"}`}>
				Code sha256: <code>{shortHash(plugin.package?.codeSha256)}</code> → <code>{shortHash(update.codeSha256)}</code>
			</Typography>
			<UpdateRegistryStatus plugin={plugin} update={update} />
			<Typography variant="body2" gutterBottom>
				Until you update, the version you have keeps running. The new code runs with the same access to TIDAL as the plugin has now. Unless the
				registry verified it, nobody checked what it does: update only if you trust the author and {plugin.url}.
			</Typography>
			{files.length !== 0 && (
				<Typography variant="body2" gutterBottom>
					Native code (runs in TIDAL's main process): {files.join(", ")}. Changed native files ask for permission again, unless you allowed this
					plugin for all versions.
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
		// One revoked while the dialog was open is refused by acceptUpdate, with a message
		if (!confirmed) return;
		setUpdating(true);
		try {
			// The update the user was shown, even if a newer one arrived meanwhile
			await plugin.acceptUpdate(update);
		} catch {
			// Already shown: a load error on the plugin's card, a refused (revoked) version in a message
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
