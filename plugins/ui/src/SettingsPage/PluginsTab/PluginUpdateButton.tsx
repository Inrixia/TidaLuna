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
 * The plugin's native files allowed for all versions: the update's native code runs without asking. "Ask again"
 * revokes those answers (as Luna Settings > Native permissions does), so they ask the next time they load.
 */
const AllVersionsWarning = ({ url }: { url: string }) => {
	const [entries, setEntries] = React.useState<NativePermissionEntry[]>([]);
	const refresh = React.useCallback(
		async () => setEntries(LunaPlugin.allowedForAllVersions(await ipcRenderer.invoke("__Luna.nativePermissions.list"), url)),
		[url],
	);
	React.useEffect(() => void refresh().catch(() => {}), [refresh]);
	const [error, setError] = React.useState<string>();
	const askAgain = React.useCallback(async () => {
		try {
			for (const { key } of entries) await ipcRenderer.invoke("__Luna.nativePermissions.revoke", key);
			setError(undefined);
		} catch (err) {
			setError(`Could not revoke: ${err instanceof Error ? err.message : String(err)}`);
		}
		await refresh().catch(() => {});
	}, [entries, refresh]);

	if (entries.length === 0) return null;
	return (
		<Alert
			severity="warning"
			sx={{ marginTop: 1 }}
			action={
				<Button color="inherit" size="small" onClick={askAgain}>
					Ask again
				</Button>
			}
		>
			Native code allowed for all versions ({entries.map(({ fileName }) => fileName).join(", ")}): the update's runs without asking.
			{error !== undefined && (
				<>
					<br />
					{error}
				</>
			)}
		</Alert>
	);
};

/** What the update changes, with links to its source where the packages say */
const UpdateDetails = ({ plugin, update }: { plugin: LunaPlugin; update: PluginPackage }) => {
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
			<AllVersionsWarning url={plugin.url} />
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
		<Tooltip title={`Update plugin${update.version === undefined ? "" : ` to ${update.version}`}`}>
			<span>
				<IconButton aria-label={`Update ${plugin.name}`} disabled={updating} onClick={onClick} sx={{ color: green[400] }}>
					<SystemUpdateAltIcon />
				</IconButton>
			</span>
		</Tooltip>
	);
});
