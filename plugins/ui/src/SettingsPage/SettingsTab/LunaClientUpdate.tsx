import { ftch } from "@luna/core";
import React from "react";

import { components } from "@octokit/openapi-types";
type GitHubRelease = components["schemas"]["release"];

import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";

import { pkg, relaunch, update, needsElevation, runElevatedInstall } from "plugins/lib.native/src/index.native";

export const version = (await pkg()).version;

import { useConfirm } from "material-ui-confirm";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";

import { RefreshIcon } from "../../components/LunaDrawnIcons";
import { LunaGroup, LunaRow, LunaSection } from "../../components/LunaList";
import { buttonSx, iconBtnSx, selectSx, wave } from "../../tidalTokens";

export const fetchReleases = () => ftch.json<GitHubRelease[]>("https://api.github.com/repos/Inrixia/TidaLuna/releases");

export const LunaClientUpdate = React.memo(() => {
	const confirm = useConfirm();
	const [releases, setReleases] = React.useState<GitHubRelease[]>([]);
	const [loading, setLoading] = React.useState(false);
	const [busy, setBusy] = React.useState<"updating" | "resetting" | null>(null);
	const [selectedRelease, setSelectedRelease] = React.useState<string>(version!);

	const updateReleases = async () => {
		setLoading(true);
		const releases = await fetchReleases().finally(() => setLoading(false));
		setReleases(releases);
		setSelectedRelease(releases[0].tag_name);
	};

	React.useEffect(() => {
		updateReleases();
	}, []);

	let action;
	let desc;
	if (selectedRelease !== version) {
		action = "Update Client";
		desc = `Update to ${selectedRelease}? You will need to restart the client.`;
	} else {
		action = "Reinstall Client";
		desc = `Reinstall ${selectedRelease}? You will need to restart the client.`;
	}

	return (
		<LunaSection
			title="Client updates"
			desc="Install another TidaLuna release, or reinstall the current one."
			trailing={
				<IconButton disableRipple disabled={loading} onClick={updateReleases} title="Fetch releases" sx={iconBtnSx} children={<RefreshIcon size={18} />} />
			}
		>
			<Dialog open={!!busy}>
				<DialogTitle>Operation in progress</DialogTitle>
				<DialogContent>
					<DialogContentText>Please do not close the application. It will restart automatically.</DialogContentText>
				</DialogContent>
			</Dialog>
			<LunaGroup>
			<LunaRow
				title="Release"
				desc="Which build to install."
				trailing={
					<Select
						size="small"
						sx={{ ...selectSx, minWidth: 200 }}
						value={selectedRelease}
						onChange={(e) => setSelectedRelease(e.target.value)}
						children={releases.map((release) => (
							<MenuItem key={release.tag_name} value={release.tag_name}>{`${release.tag_name}${release.prerelease ? "-dev" : ""}`}</MenuItem>
						))}
					/>
				}
			/>
			<LunaRow
				title={action}
				desc={desc}
				trailing={
			<Button
				disableRipple
				sx={buttonSx}
				disabled={!!busy}
				children={action}
				onClick={async () => {
					const result = await confirm({ title: action, description: desc, confirmationText: action });
					if (!result.confirmed) return;
					const releaseUrl = releases.find((r) => r.tag_name === selectedRelease)?.assets[0].browser_download_url;
					if (releaseUrl === undefined) throw new Error("Release URL not found");

					// On Linux, warn the user if elevation is needed
					if (__platform === "linux" && (await needsElevation())) {
						const elevationResult = await confirm({
							title: "Administrator privileges required",
							description:
								"TidaLuna does not have write access to the installation directory. " +
								"Your password will be requested to proceed with the update.",
							confirmationText: "Continue",
							cancellationText: "Cancel",
						});
						if (!elevationResult.confirmed) return;
					}

					const updateResult = await update(selectedRelease);

					if (updateResult === "elevation_required") {
						setBusy("updating");
						try {
							await runElevatedInstall();
						} catch (err: any) {
							setBusy(null);
							if (err.message?.includes("ELEVATION_CANCELLED")) return;
							if (err.message?.includes("NO_ELEVATION_TOOL")) {
								await confirm({
									title: "Elevation failed",
									description:
										"Neither pkexec nor kdesudo were found on your system. " +
										"Please perform this operation manually.",
									hideCancelButton: true,
								});
								return;
							}
							throw err;
						}
					}

					setBusy("updating");
					await new Promise((resolve) => setTimeout(resolve, 2000));
					await relaunch();
				}}
			/>
				}
			/>
			<LunaRow
				title="Factory reset"
				desc="Deletes every plugin and all Luna configuration, then restarts."
				trailing={
			<Button
				disableRipple
				sx={{ ...buttonSx, backgroundColor: "transparent", color: wave.danger, borderColor: wave.lineStrong, "&:hover": { backgroundColor: wave.line, borderColor: wave.danger } }}
				disabled={!!busy}
				children={"Factory Reset"}
				title={"Warning! This will reset luna to a clean install with no plugins."}
				onClick={async () => {
					const ok = await confirm({
						title: "Factory Reset",
						description: "ARE YOU SURE? This will delete and reset all plugins and configuration for Luna.",
						confirmationText: "DELETE and Restart",
					});
					if (!ok.confirmed) return;

					setBusy("resetting");
					for (const db of await indexedDB.databases()) {
						// Dont delete the tidal localforage db as it will reset the tidal app
						// Deleting other _TIDAL indexedDB databases is ok
						if (db.name === "localforage" || db.name === undefined) continue;
						indexedDB.deleteDatabase(db.name);
					}

					await relaunch();
				}}
			/>
				}
			/>
			</LunaGroup>
		</LunaSection>
	);
});
