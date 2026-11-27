import React from "react";

import { asSentence, isCoreUrl, LunaPlugin, LunaRegistry, type CodeSha256, type RevokedEntry, type VerifiedEntry } from "@luna/core";

import Chip, { type ChipProps } from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import VerifiedIcon from "@mui/icons-material/Verified";
import BlockIcon from "@mui/icons-material/Block";

const subscribeRegistry = (notify: () => void) => {
	const unloads = [
		LunaRegistry.verified.onValue(notify),
		LunaRegistry.revoked.onValue(notify),
		LunaRegistry.status.onValue(notify),
		LunaRegistry.verifiedUpdatesOnly.onValue(notify),
	];
	return () => unloads.forEach((unload) => unload());
};
/** Re-renders when the registry lists in use or "Only verified updates" change. Returns them */
export const useRegistry = () => {
	const verified = React.useSyncExternalStore(subscribeRegistry, () => LunaRegistry.verified._);
	const revoked = React.useSyncExternalStore(subscribeRegistry, () => LunaRegistry.revoked._);
	const status = React.useSyncExternalStore(subscribeRegistry, () => LunaRegistry.status._);
	const verifiedUpdatesOnly = React.useSyncExternalStore(subscribeRegistry, () => LunaRegistry.verifiedUpdatesOnly._);
	return { verified, revoked, status, verifiedUpdatesOnly };
};

export type RegistryEntry =
	{ revoked: RevokedEntry; verified?: undefined } | { verified: VerifiedEntry; sha256: string; revoked?: undefined } | undefined;
/**
 * What the registry says about this code of this plugin: revoked, verified (for `name`, the name the code carries) or nothing.
 * Luna's own plugins: nothing. `rawSha256`: the code's registry key, or the keys it may have (see packageSha256s)
 */
export const registryEntryOf = (plugin: LunaPlugin, rawSha256: CodeSha256, name: string): RegistryEntry => {
	const decision = LunaRegistry.loadDecision({ url: plugin.url, rawSha256 });
	if (!decision.load) return { revoked: decision.revoked };
	if (isCoreUrl(plugin.url)) return undefined;
	for (const sha256 of typeof rawSha256 === "string" || rawSha256 === undefined ? [rawSha256] : rawSha256) {
		const verified = sha256 === undefined ? undefined : LunaRegistry.verifiedEntry(sha256, name);
		if (verified !== undefined) return { verified, sha256: sha256! };
	}
	return undefined;
};

/** A chip that opens the registry's report, if there is one */
const ReportChip = ({ report, title, ...props }: ChipProps & { report?: string; title: string }) => (
	// The span holds the Tooltip's listeners
	<Tooltip title={title}>
		<span>
			{report === undefined ? (
				<Chip size="small" {...props} />
			) : (
				// A plain anchor, not LunaLink: its own tooltip (the url) would cover this chip's tooltip (what the badge means)
				<a href={report.startsWith("http") ? report : undefined} target="_blank" style={{ textDecoration: "none" }}>
					<Chip size="small" {...props} clickable />
				</a>
			)}
		</span>
	</Tooltip>
);

/**
 * "Verified" or "Revoked" for a plugin's code, with the registry's report. Nothing for code the registry doesn't list.
 * `name`: the name the code carries (its package's, which a renaming update changes), not the name the plugin was installed under
 */
export const RegistryBadge = React.memo(({ plugin, rawSha256, name }: { plugin: LunaPlugin; rawSha256: CodeSha256; name: string }) => {
	useRegistry();
	const entry = registryEntryOf(plugin, rawSha256, name);
	if (entry?.revoked !== undefined)
		return (
			<ReportChip
				title={`Revoked by the Luna plugin registry: ${asSentence(entry.revoked.reason)}${entry.revoked.report ? ` Report: ${entry.revoked.report}` : ""}`}
				color="error"
				icon={<BlockIcon />}
				label="Revoked"
				report={entry.revoked.report}
			/>
		);
	if (entry?.verified !== undefined)
		return (
			<ReportChip
				title={`This exact build (sha256 ${entry.sha256.slice(0, 12)}…) was built from ${entry.verified.repo ?? "its source"} and reviewed by the Luna plugin registry${entry.verified.report ? `. Report: ${entry.verified.report}` : ""}`}
				color="success"
				icon={<VerifiedIcon />}
				label="Verified"
				report={entry.verified.report}
			/>
		);
	return null;
});
