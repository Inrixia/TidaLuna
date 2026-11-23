import React from "react";

import { isCoreUrl, LunaPlugin, LunaRegistry, type RevokedEntry, type VerifiedEntry } from "@luna/core";

import Chip, { type ChipProps } from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import VerifiedIcon from "@mui/icons-material/Verified";
import BlockIcon from "@mui/icons-material/Block";

const subscribeRegistry = (notify: () => void) => {
	const unloads = [LunaRegistry.verified.onValue(notify), LunaRegistry.revoked.onValue(notify), LunaRegistry.status.onValue(notify)];
	return () => unloads.forEach((unload) => unload());
};
/** Re-renders when the registry lists in use change. Returns them */
export const useRegistry = () => {
	const verified = React.useSyncExternalStore(subscribeRegistry, () => LunaRegistry.verified._);
	const revoked = React.useSyncExternalStore(subscribeRegistry, () => LunaRegistry.revoked._);
	const status = React.useSyncExternalStore(subscribeRegistry, () => LunaRegistry.status._);
	return { verified, revoked, status };
};

export type RegistryEntry = { revoked: RevokedEntry; verified?: undefined } | { verified: VerifiedEntry; revoked?: undefined } | undefined;
/** What the registry says about this code of this plugin: revoked, verified (for this plugin's name) or nothing. Luna's own plugins: nothing */
export const registryEntryOf = (plugin: LunaPlugin, rawSha256: string | undefined): RegistryEntry => {
	const decision = LunaRegistry.loadDecision({ url: plugin.url, rawSha256 });
	if (!decision.load) return { revoked: decision.revoked };
	if (isCoreUrl(plugin.url)) return undefined;
	const verified = LunaRegistry.verifiedEntry(rawSha256, plugin.name);
	return verified === undefined ? undefined : { verified };
};

/** A chip that opens the registry's report, if there is one */
const ReportChip = ({ report, title, ...props }: ChipProps & { report?: string; title: string }) => (
	// The span holds the Tooltip's listeners
	<Tooltip title={title}>
		<span>
			{report === undefined ? (
				<Chip size="small" {...props} />
			) : (
				<a href={report} target="_blank" style={{ textDecoration: "none" }}>
					<Chip size="small" {...props} clickable />
				</a>
			)}
		</span>
	</Tooltip>
);

/** "Verified" or "Revoked" for a plugin's code, with the registry's report. Nothing for code the registry doesn't list */
export const RegistryBadge = React.memo(({ plugin, rawSha256 }: { plugin: LunaPlugin; rawSha256?: string }) => {
	useRegistry();
	const entry = registryEntryOf(plugin, rawSha256);
	if (entry?.revoked !== undefined)
		return (
			<ReportChip
				title={`Revoked by the Luna plugin registry: ${entry.revoked.reason}${entry.revoked.report ? `. Report: ${entry.revoked.report}` : ""}`}
				color="error"
				icon={<BlockIcon />}
				label="Revoked"
				report={entry.revoked.report}
			/>
		);
	if (entry?.verified !== undefined)
		return (
			<ReportChip
				title={`This exact build (sha256 ${rawSha256?.slice(0, 12)}…) was built from ${entry.verified.repo ?? "its source"} and reviewed by the Luna plugin registry${entry.verified.report ? `. Report: ${entry.verified.report}` : ""}`}
				color="success"
				icon={<VerifiedIcon />}
				label="Verified"
				report={entry.verified.report}
			/>
		);
	return null;
});
