/**
 * What starts the unattended run.
 *
 * TIDAL owns its install folder, so the run cannot live there and cannot be started by Luna: by the time Luna would be
 * running, whatever a TIDAL update did has already happened. It has to be started by the system, with TIDAL closed.
 *
 * There is no separate runtime to install: TIDAL ships Electron, and Electron run with `ELECTRON_RUN_AS_NODE` is Node. So
 * the artifacts here are a wrapper that sets that and a schedule entry that calls it. They are generated as text rather
 * than installed: registering a logon task or a systemd unit is a change to the machine that someone should see happen,
 * and every string here is testable.
 */

export type RunnerPaths = {
	/** The Electron binary to run the script with: TIDAL's own */
	electron: string;
	/** The built entry point (see esbuild.config.ts) */
	script: string;
};

/** A path as a script argument: quoted, so a space in an install path does not split it */
const quoted = (value: string) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);

/**
 * The wrapper the schedule entry calls. It exists to set `ELECTRON_RUN_AS_NODE`, which is environment and cannot be
 * passed as an argument, and to give the schedule one stable path to call.
 */
export const wrapperFor = (platform: NodeJS.Platform, { electron, script }: RunnerPaths): string => {
	if (platform === "win32") {
		return [
			"@echo off",
			"rem Runs Luna's TIDAL update check. Generated; see native/autoUpdateSchedule.ts",
			"set ELECTRON_RUN_AS_NODE=1",
			`${quoted(electron)} ${quoted(script)}`,
			"",
		].join("\r\n");
	}
	return [
		"#!/bin/sh",
		"# Runs Luna's TIDAL update check. Generated; see native/autoUpdateSchedule.ts",
		`ELECTRON_RUN_AS_NODE=1 ${quoted(electron)} ${quoted(script)}`,
		"",
	].join("\n");
};

/** Whether a wrapper is a `.cmd` (Windows) or a shell script */
export const wrapperName = (platform: NodeJS.Platform) => (platform === "win32" ? "luna-update-guard.cmd" : "luna-update-guard.sh");

/**
 * A Task Scheduler definition that runs the wrapper at logon.
 *
 * At logon because that is when a person is there to have updated TIDAL, and because the run needs their TIDAL closed
 * rather than their session started. It runs as the user, so no elevation: Luna's own folder and TIDAL's per-user install
 * are both writable by them.
 */
export const windowsTaskXml = ({
	wrapper,
	userId = "%USERNAME%",
	logonDelay = "PT1M",
}: {
	wrapper: string;
	userId?: string;
	logonDelay?: string;
}) =>
	`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
	<RegistrationInfo>
		<Description>Puts Luna back after TIDAL updates itself</Description>
	</RegistrationInfo>
	<Triggers>
		<LogonTrigger>
			<Enabled>true</Enabled>
			<Delay>${logonDelay}</Delay>
		</LogonTrigger>
	</Triggers>
	<Principals>
		<Principal id="Author">
			<UserId>${userId}</UserId>
			<LogonType>InteractiveToken</LogonType>
			<RunLevel>LeastPrivilege</RunLevel>
		</Principal>
	</Principals>
	<Settings>
		<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
		<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
		<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
		<StartWhenAvailable>true</StartWhenAvailable>
		<ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
	</Settings>
	<Actions Context="Author">
		<Exec>
			<Command>${wrapper}</Command>
		</Exec>
	</Actions>
</Task>
`;

/**
 * A systemd user timer: the same run, once per login, before the user is likely to have opened TIDAL.
 *
 * A user unit rather than a system one, because the install it repairs is the user's and the run must not need root.
 */
export const systemdUnits = ({ wrapper }: { wrapper: string }) => ({
	service: `[Unit]
Description=Puts Luna back after TIDAL updates itself
After=default.target

[Service]
Type=oneshot
ExecStart=${wrapper}
`,
	timer: `[Unit]
Description=Runs Luna's TIDAL update check after login

[Timer]
OnStartupSec=1min
Persistent=false

[Install]
WantedBy=timers.target
`,
});

/** A launchd agent, the same idea on macOS */
export const launchAgentPlist = ({ wrapper, label = "dev.luna.update-guard" }: { wrapper: string; label?: string }) =>
	`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${wrapper}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
</dict>
</plist>
`;
