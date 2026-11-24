import React from "react";

import { LunaPlugin, type PluginPackage } from "@luna/core";
import { ipcRenderer } from "@luna/lib";
import { useConfirm } from "material-ui-confirm";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import SystemUpdateAltIcon from "@mui/icons-material/SystemUpdateAlt";
import { green } from "@mui/material/colors";

import type { NativePermissionEntry } from "../../../../../native/NativeModule/trust";
import { LunaLink } from "../../components";

/** First 12 hex digits, enough to tell versions apart and compare with a published hash */
const shortHash = (sha256?: string) => (sha256 === undefined ? "?" : sha256.slice(0, 12));

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
			<Typography variant="body2">
				Update only if you trust the author and <LunaLink href={plugin.url}>{plugin.url}</LunaLink>
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
		if (!confirmed) return;
		setUpdating(true);
		try {
			for (const key of revoke) await ipcRenderer.invoke("__Luna.nativePermissions.revoke", key);
		} catch (err) {
			// The update still applies: files already revoked ask when it loads, the rest keep their answer
			plugin.trace.msg.err.withContext("Couldn't revoke all of the plugin's native permissions")(err);
		}
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
		<Tooltip title={`Update plugin${update.version === undefined ? "" : ` to ${update.version}`}`}>
			<span>
				<IconButton aria-label={`Update ${plugin.name}`} disabled={updating} onClick={onClick} sx={{ color: green[400] }}>
					<SystemUpdateAltIcon />
				</IconButton>
			</span>
		</Tooltip>
	);
});
