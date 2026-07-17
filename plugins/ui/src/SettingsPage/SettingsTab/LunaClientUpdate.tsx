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
import { LunaButton, LunaSettings, SpinningButton } from "../../components";

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
		<LunaSettings
			title="Client Updates"
			titleChildren={<SpinningButton title="Fetch releases" loading={loading} onClick={updateReleases} />}
			direction="row"
			alignItems="center"
			pb={4}
		>
			<Dialog open={!!busy}>
				<DialogTitle>Operation in progress</DialogTitle>
				<DialogContent>
					<DialogContentText>Please do not close the application. It will restart automatically.</DialogContentText>
				</DialogContent>
			</Dialog>
			<Select
				fullWidth
				sx={{ flex: 1, height: 48 }}
				value={selectedRelease}
				onChange={(e) => setSelectedRelease(e.target.value)}
				children={releases.map((release) => {
					return <MenuItem value={release.tag_name}>{`${release.tag_name}${release.prerelease ? "-dev" : ""}`}</MenuItem>;
				})}
			/>
			<LunaButton
				sx={{ height: 48 }}
				disabled={!!busy}
				children={action}
				title={desc}
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
			<LunaButton
				sx={{ height: 48, marginLeft: 2 }}
				color="error"
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
		</LunaSettings>
	);
});
