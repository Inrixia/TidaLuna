import { ipcRenderer } from "@luna/lib";
import React from "react";

import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { LunaSetting, LunaSettings } from "../../components";

import type { UpdateGuardStatus } from "../../../../../native/autoUpdateStatus";

const actions = {
	installed: "text.primary",
	none: "text.secondary",
	refused: "warning.main",
	failed: "error.main",
} as const;

const actionColor = (action: string) => actions[action as keyof typeof actions] ?? "text.secondary";

/** What the unattended run did, without offering to start one: that belongs behind the confirmation window */
export const LunaUpdateGuard = React.memo(() => {
	const [status, setStatus] = React.useState<UpdateGuardStatus | undefined>();
	const refresh = React.useCallback(async () => setStatus(await ipcRenderer.invoke("__Luna.getUpdateGuardStatus").catch(() => undefined)), []);
	React.useEffect(() => void refresh(), [refresh]);

	// Nothing to say on a machine that never had Luna: the run does nothing there either, and a card explaining that would
	// only be noise on someone else's install
	if (status?.installed === undefined) return null;

	return (
		<LunaSettings
			title="TIDAL updates"
			desc="TIDAL replaces its own install when it updates, which removes Luna until it is put back. Luna's record of being installed here is what lets a run put it back, on the next logon with TIDAL closed."
		>
			<LunaSetting
				title="Installed for TIDAL"
				desc={`Luna ${status.installed.lunaVersion}${status.installed.pinnedVersion === undefined ? "" : ` (pinned to ${status.installed.pinnedVersion})`}`}
			/>
			<LunaSetting
				title="Automatic restore"
				desc={
					status.installed.autoUpgrade
						? "On: a newer Luna is installed when one supports the TIDAL that is running."
						: "Off: only the version above is reinstalled."
				}
			/>
			{status.lastRun === undefined ? (
				<LunaSetting title="Last check" desc="Not run yet. It runs one minute after logon." />
			) : (
				<LunaSetting
					title="Last check"
					desc={
						<Stack spacing={0.5}>
							<Typography variant="body2" color={actionColor(status.lastRun.action)}>
								{status.lastRun.action}
							</Typography>
							<Typography variant="body2">{status.lastRun.reason}</Typography>
							{status.lastRun.at !== "" && (
								<Typography variant="caption" color="text.secondary">
									{new Date(status.lastRun.at).toLocaleString()}
								</Typography>
							)}
						</Stack>
					}
				/>
			)}
		</LunaSettings>
	);
});
