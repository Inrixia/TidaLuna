import React from "react";

import { LunaPlugin, unverifiedPlugins, type RegistryFileStatus } from "@luna/core";
import { effect } from "oby";

import Alert from "@mui/material/Alert";

import { useRegistry } from "./RegistryBadge";

/** The registry lists in use, for the banner: which serial, and why a fresh one wasn't used */
const describeStatus = (fileName: string, status: RegistryFileStatus) => {
	if (status.source === "none") return `${fileName}: not available${status.error ? ` (${status.error})` : ""}`;
	const copy = status.source === "fetched" ? "fetched now" : "last good copy";
	return `${fileName}: #${status.serial}, ${copy}${status.error ? ` (newer copy not used: ${status.error})` : ""}`;
};

const Lists = ({ text }: { text: string }) => <div style={{ opacity: 0.7, fontSize: "0.85em", marginTop: 4 }}>{text}</div>;

/**
 * "N unverified plugins enabled" above the plugin list. All plugins share one JS realm: one unverified plugin can patch verified ones,
 * so a Verified badge means little while this is not 0. Counts every enabled plugin that isn't Luna's own (by url) or revoked, dev plugins included.
 */
export const UnverifiedBanner = React.memo(() => {
	const { verified, revoked, status } = useRegistry();
	const [plugins, setPlugins] = React.useState<
		{ url: string; name: string; installed: boolean; enabled: boolean; rawSha256: string | undefined }[]
	>([]);
	// The fields read here are oby-tracked: re-run when plugins are added, enabled, disabled, or their code changes
	React.useEffect(
		() =>
			effect(
				() =>
					setPlugins(
						Object.values(LunaPlugin.plugins).map((plugin) => ({
							url: plugin.store.url,
							name: plugin.name,
							installed: plugin.store.installed,
							enabled: plugin.store.enabled,
							rawSha256: plugin.store.package?.rawSha256,
						})),
					),
				{ sync: true },
			),
		[],
	);
	const unverified = unverifiedPlugins(plugins, verified, revoked);
	const lists = `Plugin registry: ${describeStatus("verified.json", status["verified.json"])}; ${describeStatus("revoked.json", status["revoked.json"])}.`;
	if (unverified.length === 0)
		return (
			<Alert severity="success" variant="filled">
				All enabled plugins are verified by the Luna plugin registry.
				<Lists text={lists} />
			</Alert>
		);
	return (
		<Alert severity="warning" variant="filled">
			<b>
				{unverified.length} unverified plugin{unverified.length === 1 ? "" : "s"} enabled
			</b>
			: {unverified.map((plugin) => plugin.name).join(", ")}. All plugins run in the same page with full access to TIDAL and to each other, so an
			unverified plugin can also change what verified plugins do.
			<Lists text={lists} />
		</Alert>
	);
});
