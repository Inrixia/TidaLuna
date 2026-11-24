import React from "react";

import { asSentence, LunaPlugin, LunaRegistry, type PluginPackage } from "@luna/core";
import { ipcRenderer } from "@luna/lib";
import { useConfirm } from "material-ui-confirm";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import SystemUpdateAltIcon from "@mui/icons-material/SystemUpdateAlt";
import { green } from "@mui/material/colors";

import type { NativePermissionEntry } from "../../../../../native/NativeModule/trust";
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

const MaybeLink = ({ href, children }: { href?: string; children: React.ReactNode }) =>
	href === undefined ? <>{children}</> : <LunaLink href={href}>{children}</LunaLink>;

/**
 * The plugin's native files allowed for all versions: the update's native code runs without asking. "Ask again" chooses
 * to revoke those answers when the user updates (as Luna Settings > Native permissions does), so they ask when the new
 * code loads. Not at once: that would stop the running version's native code too, also if the user doesn't update.
 */
const AllVersionsWarning = ({ url, onAskAgain }: { url: string; onAskAgain: (keys: string[]) => void }) => {
	const [entries, setEntries] = React.useState<NativePermissionEntry[]>([]);
	const [chosen, setChosen] = React.useState(false);
	React.useEffect(() => {
		ipcRenderer
			.invoke("__Luna.nativePermissions.list")
			.then((list: NativePermissionEntry[]) => setEntries(LunaPlugin.allowedForAllVersions(list, url)))
			.catch(() => {});
	}, [url]);
	const askAgain = React.useCallback(() => {
		onAskAgain(entries.map(({ key }) => key));
		setChosen(true);
	}, [entries, onAskAgain]);

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

/** What the update changes, with links to its source where the packages say */
const UpdateDetails = ({ plugin, update, onAskAgain }: { plugin: LunaPlugin; update: PluginPackage; onAskAgain: (keys: string[]) => void }) => {
	const current: Partial<PluginPackage> = plugin.package ?? {};
	const links = LunaPlugin.updateLinks(plugin.url, current, update);
	return (
		<>
			<Typography variant="body2" gutterBottom>
				<MaybeLink href={links.from}>
					<b>{current.version ?? "?"}</b>
				</MaybeLink>
				{" → "}
				<MaybeLink href={links.to}>
					<b>{update.version ?? "?"}</b>
				</MaybeLink>
				{links.release !== undefined && (
					<>
						{" ("}
						<LunaLink href={links.release.page}>release {links.release.tag}</LunaLink>)
					</>
				)}
			</Typography>
			<Typography variant="body2" gutterBottom title={`sha256 ${current.codeSha256 ?? "?"} → ${update.codeSha256 ?? "?"}`}>
				Code sha256: <code>{shortHash(current.codeSha256)}</code> → <code>{shortHash(update.codeSha256)}</code>
				{links.compare !== undefined && (
					<>
						{" ("}
						<MaybeLink href={links.compare}>changes</MaybeLink>)
					</>
				)}
			</Typography>
			<UpdateRegistryStatus plugin={plugin} update={update} />
			<Typography variant="body2">
				Update only if you trust the author and <LunaLink href={`${plugin.url}.json`}>{plugin.url}</LunaLink>
			</Typography>
			<AllVersionsWarning url={plugin.url} onAskAgain={onAskAgain} />
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
		// Answers the user chose to revoke in the dialog ("Ask again"), revoked only if they update
		let revoke: string[] = [];
		const { confirmed } = await confirm({
			title: `Update ${plugin.name}?`,
			description: <UpdateDetails plugin={plugin} update={update} onAskAgain={(keys) => (revoke = keys)} />,
			confirmationText: "Update",
			cancellationText: "Not now",
		});
		// One revoked while the dialog was open is refused by acceptUpdate, with a message
		if (!confirmed) return;
		setUpdating(true);
		// Right before the update is applied: an update that doesn't go ahead leaves the answers, and the running version
		// keeps its native code. If one can't be revoked, the update doesn't apply: its code would run without asking
		const revokeChosen = async () => {
			let failed = 0;
			for (const key of revoke) await ipcRenderer.invoke("__Luna.nativePermissions.revoke", key).catch(() => failed++);
			if (failed !== 0) plugin.trace.msg.err.throw(`Not updating ${plugin.name}: couldn't revoke its native permissions for all versions`);
		};
		try {
			// The update the user was shown, even if a newer one arrived meanwhile
			await plugin.acceptUpdate(update, revoke.length === 0 ? undefined : revokeChosen);
		} catch {
			// Already shown: a load error on the plugin's card, a refused (revoked) version in a message
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
