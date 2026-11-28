import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";

import { launchAgentPlist, systemdUnits, windowsTaskXml, wrapperFor, wrapperName } from "./autoUpdateSchedule";
import { RUNNER_FILE } from "./publishRunner";

/**
 * Luna registering the run that puts it back, so keeping it alive is not the user's job.
 *
 * It writes a wrapper into Luna's own folder (outside TIDAL's tree, so an update cannot replace it) and registers that
 * wrapper with the platform's schedule: a Task Scheduler entry on Windows, a systemd user timer on Linux, a LaunchAgent on
 * macOS. Every call is made as the user, never with elevation — the only folders involved are the user's own, and a
 * prompt for admin rights to keep a client mod patched would be a good reason to refuse.
 *
 * Registered once and then left alone: a record is kept in Luna's state, so a user who removes the schedule is not fought
 * by every later start.
 */

export type Mechanism = "schtasks" | "systemd" | "launchd" | "none";

export type ScheduleOutcome = { installed: boolean; mechanism: Mechanism; reason: string };

export type InstallScheduleDeps = {
	platform: NodeJS.Platform;
	/** Luna's own folder: where the wrapper goes, and where the run is */
	stateRoot: string;
	home: string;
	/** The Electron binary to run the check with — `process.execPath` inside TIDAL */
	electron: string;
	/** Runs a command; resolves undefined when it could not be run at all */
	run: (command: string, args: string[]) => Promise<{ code: number; stdout: string } | undefined>;
};

const TASK_NAME = "Luna TIDAL update check";
const UNIT = "luna-update-guard";
const LABEL = "dev.luna.update-guard";

/**
 * The real runner: a command that cannot be run counts as not having run, and so does a non-zero exit. Nothing here
 * escalates, so no command needs a password and none asks for one.
 */
export const execRunner: InstallScheduleDeps["run"] = async (command, args) => {
	const { execFile } = await import("child_process");
	return new Promise((resolve) => {
		execFile(command, args, (err, stdout) => {
			if (err !== null) return resolve(undefined);
			resolve({ code: 0, stdout: String(stdout) });
		});
	});
};

/** Whether a command succeeded. A missing tool and a non-zero exit are the same answer here: it did not happen */
const ok = async (deps: InstallScheduleDeps, command: string, args: string[]) => {
	const result = await deps.run(command, args).catch(() => undefined);
	return result !== undefined && result.code === 0;
};

const write = async (target: string, contents: string, mode?: number) => {
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, contents, mode === undefined ? undefined : { mode });
};

/** Reads a file, or undefined when it is not there — so a re-run can tell whether anything actually changed */
const read = (target: string) =>
	readFile(target, "utf8").then(
		(contents) => contents,
		() => undefined,
	);

export const schedulePathsFor = ({ platform, stateRoot, home }: { platform: NodeJS.Platform; stateRoot: string; home: string }) => {
	if (platform === "win32") return { wrapper: path.join(stateRoot, wrapperName(platform)), registration: path.join(stateRoot, `${UNIT}.xml`) };
	if (platform === "darwin")
		return { wrapper: path.join(stateRoot, wrapperName(platform)), registration: path.join(home, "Library/LaunchAgents", `${LABEL}.plist`) };
	return { wrapper: path.join(stateRoot, wrapperName(platform)), registration: path.join(home, ".config/systemd/user", `${UNIT}.service`) };
};

/**
 * Writes the wrapper and registers it with this platform's schedule.
 *
 * @param deps `run` is where a test stands in for the platform
 */
const attemptInstall = async (deps: InstallScheduleDeps): Promise<ScheduleOutcome> => {
	const script = path.join(deps.stateRoot, RUNNER_FILE);
	if ((await read(script)) === undefined) return { installed: false, mechanism: "none", reason: `the run is not at ${script} yet` };

	const { wrapper } = schedulePathsFor(deps);
	const contents = wrapperFor(deps.platform, { electron: deps.electron, script });
	// Only rewritten when it differs: a start should not touch the machine to say what is already true
	if ((await read(wrapper)) !== contents) await write(wrapper, contents, deps.platform === "win32" ? undefined : 0o755);

	if (deps.platform === "win32") {
		const xml = path.join(deps.stateRoot, `${UNIT}.xml`);
		await write(xml, windowsTaskXml({ wrapper }));
		// /F replaces an existing entry, so this is safe to repeat; no /RU, so it runs as the user who is logged in
		const registered = await ok(deps, "schtasks", ["/Create", "/XML", xml, "/TN", TASK_NAME, "/F"]);
		return registered
			? { installed: true, mechanism: "schtasks", reason: `registered "${TASK_NAME}" to run at logon` }
			: { installed: false, mechanism: "schtasks", reason: "schtasks could not register the task" };
	}

	if (deps.platform === "darwin") {
		const plist = path.join(deps.home, "Library/LaunchAgents", `${LABEL}.plist`);
		await write(plist, launchAgentPlist({ wrapper, label: LABEL }));
		const loaded = await ok(deps, "launchctl", ["load", "-w", plist]);
		return loaded
			? { installed: true, mechanism: "launchd", reason: `loaded the ${LABEL} LaunchAgent` }
			: { installed: false, mechanism: "launchd", reason: "launchctl could not load the agent" };
	}

	const { service, timer } = systemdUnits({ wrapper });
	const unitDir = path.join(deps.home, ".config/systemd/user");
	await write(path.join(unitDir, `${UNIT}.service`), service);
	await write(path.join(unitDir, `${UNIT}.timer`), timer);
	if (!(await ok(deps, "systemctl", ["--user", "daemon-reload"])))
		return { installed: false, mechanism: "systemd", reason: "systemctl --user daemon-reload failed" };
	if (!(await ok(deps, "systemctl", ["--user", "enable", "--now", `${UNIT}.timer`])))
		return { installed: false, mechanism: "systemd", reason: `systemctl --user could not enable ${UNIT}.timer` };
	return { installed: true, mechanism: "systemd", reason: `enabled ${UNIT}.timer in the user session` };
};

/**
 * Registers the run, or says why it could not.
 *
 * Never throws: it runs on the boot path, and a machine that cannot register this should still start TIDAL. The caller
 * keeps the reason for the log rather than having it lost to an unhandled rejection.
 */
export const installSchedule = async (deps: InstallScheduleDeps): Promise<ScheduleOutcome> => {
	try {
		return await attemptInstall(deps);
	} catch (err) {
		return { installed: false, mechanism: "none", reason: `could not register the schedule: ${(err as Error).message}` };
	}
};

/**
 * Takes the schedule back off the machine, for a user who changes their mind.
 *
 * A logon task is a persistent change, so turning it off has to be possible from inside the app rather than only by
 * finding the task by hand. The files it wrote are removed too, since nothing else reads them.
 */
export const removeSchedule = async (deps: Pick<InstallScheduleDeps, "platform" | "home" | "run">): Promise<ScheduleOutcome> => {
	try {
		if (deps.platform === "win32") {
			const removed = await ok(deps as InstallScheduleDeps, "schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]);
			return { installed: false, mechanism: "schtasks", reason: removed ? `removed "${TASK_NAME}"` : `"${TASK_NAME}" was not registered` };
		}
		if (deps.platform === "darwin") {
			const plist = path.join(deps.home, "Library/LaunchAgents", `${LABEL}.plist`);
			await ok(deps as InstallScheduleDeps, "launchctl", ["unload", "-w", plist]);
			await rm(plist, { force: true }).catch(() => {});
			return { installed: false, mechanism: "launchd", reason: "unloaded the LaunchAgent" };
		}
		const unitDir = path.join(deps.home, ".config/systemd/user");
		await ok(deps as InstallScheduleDeps, "systemctl", ["--user", "disable", "--now", `${UNIT}.timer`]);
		for (const file of [`${UNIT}.service`, `${UNIT}.timer`]) await rm(path.join(unitDir, file), { force: true }).catch(() => {});
		await ok(deps as InstallScheduleDeps, "systemctl", ["--user", "daemon-reload"]);
		return { installed: false, mechanism: "systemd", reason: `disabled ${UNIT}.timer` };
	} catch (err) {
		return { installed: false, mechanism: "none", reason: `could not remove the schedule: ${(err as Error).message}` };
	}
};
