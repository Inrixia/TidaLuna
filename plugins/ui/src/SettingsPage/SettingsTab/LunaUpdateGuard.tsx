import { ipcRenderer } from "@luna/lib";
import React from "react";

import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { LunaSetting, LunaSettings } from "../../components";

import type { RecoveryStatus } from "../../../../../native/updateRecovery";
import type { UpdateGuardStatus } from "../../../../../native/autoUpdateStatus";

const actions = {
	installed: "text.primary",
	none: "text.secondary",
	refused: "warning.main",
	failed: "error.main",
} as const;

const actionColor = (action: string) => actions[action as keyof typeof actions] ?? "text.secondary";

const mechanismText = (mechanism?: string) => {
	switch (mechanism) {
		case "schtasks":
			return "a Task Scheduler entry that runs at logon";
		case "systemd":
			return "a systemd user timer that runs after login";
		case "launchd":
			return "a LaunchAgent that runs when you log in";
		default:
			return undefined;
	}
};

/**
 * What the unattended run did, and the switch for whether it may run at all.
 *
 * The switch is here because the answer is given once at boot: without it, someone who said no (or yes) could only change
 * their mind by finding the task on their machine. Setting the answer asks the main process to register or remove the
 * schedule; nothing here starts an install, which stays behind the boot-time question.
 */
export const LunaUpdateGuard = React.memo(() => {
	const [status, setStatus] = React.useState<UpdateGuardStatus | undefined>();
	const [recovery, setRecovery] = React.useState<RecoveryStatus | undefined>();
	const [busy, setBusy] = React.useState(false);

	const refresh = React.useCallback(async () => {
		const [nextStatus, nextRecovery] = await Promise.all([
			ipcRenderer.invoke("__Luna.getUpdateGuardStatus").catch(() => undefined),
			ipcRenderer.invoke("__Luna.getUpdateRecovery").catch(() => undefined),
		]);
		setStatus(nextStatus);
		setRecovery(nextRecovery);
	}, []);
	React.useEffect(() => void refresh(), [refresh]);

	const setDecision = React.useCallback(
		async (decision: "enabled" | "declined") => {
			setBusy(true);
			try {
				await ipcRenderer.invoke("__Luna.setUpdateRecovery", decision);
			} finally {
				setBusy(false);
				await refresh();
			}
		},
		[refresh],
	);

	// Nothing to say on a machine that never had Luna: the run does nothing there either
	if (status?.installed === undefined) return null;

	const enabled = recovery?.decision === "enabled";
	const mechanism = mechanismText(recovery?.mechanism);

	return (
		<LunaSettings
			title="TIDAL updates"
			desc="TIDAL replaces its own install when it updates, which removes Luna until it is put back. Luna's record of being installed here is what lets a check put it back, after you log in, with TIDAL closed."
		>
			<LunaSetting
				title="Installed for TIDAL"
				desc={`Luna ${status.installed.lunaVersion}${status.installed.pinnedVersion === undefined ? "" : ` (pinned to ${status.installed.pinnedVersion})`}`}
			/>
			<LunaSetting
				title="Put Luna back automatically"
				desc={
					<Stack spacing={1}>
						<Typography variant="body2" color={enabled ? "text.primary" : "text.secondary"}>
							{recovery?.decision === undefined
								? "Not answered yet. Luna asks once, and does nothing until it is answered."
								: enabled
									? `On — ${mechanism ?? "registered"} once after you log in.`
									: "Off. Luna will not restore itself after a TIDAL update, and you will need to reinstall it."}
						</Typography>
						<Button
							variant={enabled ? "outlined" : "contained"}
							size="small"
							disabled={busy}
							onClick={() => void setDecision(enabled ? "declined" : "enabled")}
						>
							{enabled ? "Turn off" : "Enable"}
						</Button>
					</Stack>
				}
			/>
			{status.lastRun === undefined ? (
				<LunaSetting title="Last check" desc="Not run yet. It runs a minute after logon once enabled." />
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
