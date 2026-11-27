import React from "react";

import { asSentence, type LunaPlugin, type PluginPackage } from "@luna/core";

import Typography from "@mui/material/Typography";

import { LunaLink } from "../../../components";
import { RegistryBadge, registryEntryOf, useRegistry } from "../RegistryBadge";

/** First 12 hex digits, enough to tell versions apart and compare with a published hash */
const shortHash = (sha256?: string) => (sha256 === undefined ? "?" : sha256.slice(0, 12));

/** What the plugin registry says about the new version's exact code (its raw sha256, the registry's key) */
export const UpdateRegistryStatus = ({ plugin, update }: { plugin: LunaPlugin; update: PluginPackage }) => {
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
