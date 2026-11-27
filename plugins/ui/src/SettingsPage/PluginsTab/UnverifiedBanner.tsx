import React from "react";

import { isCoreUrl, LunaPlugin, LunaRegistry, packageSha256s, unverifiedPlugins, type CodeSha256, type RegistryFileStatus } from "@luna/core";
import { effect } from "oby";

import Alert from "@mui/material/Alert";

import { useRegistry } from "./RegistryBadge";

/** The registry lists in use, for the banner: which serial, and why a fresh one wasn't used */
const describeStatus = (fileName: string, status: RegistryFileStatus) => {
	if (status.source === "none") return `${fileName}: not available${status.error ? ` (${status.error})` : ""}`;
	const copy = status.source === "fetched" ? "fetched this session" : "last good copy";
	return `${fileName}: #${status.serial}, ${copy}${status.error ? ` (newer copy not used: ${status.error})` : ""}`;
};

const Lists = ({ text }: { text: string }) => <div style={{ opacity: 0.7, fontSize: "0.85em", marginTop: 4 }}>{text}</div>;

/**
 * "N unverified plugins enabled" above the plugin list. All plugins share one JS realm: one unverified plugin can patch verified ones,
 * so a Verified badge means little while this is not 0. Counts every enabled plugin that isn't Luna's own (by url) or revoked, dev plugins included.
 */
export const UnverifiedBanner = React.memo(() => {
	const { verified, revoked, status } = useRegistry();
	const [plugins, setPlugins] = React.useState<{ url: string; name: string; installed: boolean; enabled: boolean; rawSha256: CodeSha256 }[]>([]);
	// The fields read here are oby-tracked: re-run when plugins are added, enabled, disabled, or their code changes
	React.useEffect(
		() =>
			effect(
				() =>
					setPlugins(
						Object.values(LunaPlugin.plugins).map((plugin) => ({
							url: plugin.store.url,
							// The name the code carries: a renaming update changes it, the plugin keeps the name it was installed under
							name: plugin.store.package?.name ?? plugin.name,
							installed: plugin.store.installed,
							enabled: plugin.store.enabled,
							rawSha256: packageSha256s(plugin.store.package),
						})),
					),
				{ sync: true },
			),
		[],
	);
	const unverified = unverifiedPlugins(plugins, verified, revoked);
	const lists = `Plugin registry: ${describeStatus("verified.json", status["verified.json"])}; ${describeStatus("revoked.json", status["revoked.json"])}.`;
	// A blocked or failing fetch must not pass quietly: revocations published since the copy in use don't apply
	const stale = status["revoked.json"].error !== undefined && (
		<div style={{ fontWeight: "bold", marginTop: 4 }}>
			{status["revoked.json"].source === "none"
				? "Could not get the list of revoked plugins, so no revocations apply."
				: `Could not get the latest list of revoked plugins, using #${status["revoked.json"].serial}${status["revoked.json"].generated ? ` from ${status["revoked.json"].generated.slice(0, 10)}` : ""}. Plugins revoked since then still run.`}
		</div>
	);
	if (unverified.length === 0) {
		// Green only when there is something verified to speak of: a running plugin that isn't Luna's own, checked against a verified.json
		const thirdParty = plugins.some(
			(plugin) => plugin.installed && plugin.enabled && !isCoreUrl(plugin.url) && LunaRegistry.revokedEntry(plugin.rawSha256) === undefined,
		);
		// (Without a verified.json every such plugin counts as unverified, so here thirdParty means they are all verified)
		return (
			<Alert severity={stale ? "warning" : thirdParty ? "success" : "info"} variant="filled">
				{thirdParty ? "All enabled plugins are verified by the Luna plugin registry." : "No plugins other than Luna's own are enabled."}
				{stale}
				<Lists text={lists} />
			</Alert>
		);
	}
	return (
		<Alert severity="warning" variant="filled">
			<b>
				{unverified.length} unverified plugin{unverified.length === 1 ? "" : "s"} enabled
			</b>
			: {unverified.map((plugin) => plugin.name).join(", ")}. All plugins run in the same page with full access to TIDAL and to each other, so an
			unverified plugin can also change what verified plugins do.
			{stale}
			<Lists text={lists} />
		</Alert>
	);
});
