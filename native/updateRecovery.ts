import { readLunaState, writeLunaState, type LunaState } from "./lunaState";
import { execRunner, installSchedule, removeSchedule, type ScheduleOutcome } from "./installSchedule";

/**
 * Whether Luna may keep itself installed after TIDAL updates, as the user answered.
 *
 * Registering a logon task is a persistent change to someone's machine, so it is asked for rather than assumed: the answer
 * is stored here, and only an `enabled` answer ever registers anything. `declined` is remembered too, so the question is
 * asked once instead of on every start.
 *
 * The answer is recorded before the registration is attempted, so a machine that cannot register does not get asked
 * again — it gets the reason in its log, and one retry on the next start while the answer says enabled.
 */

export type RecoveryDecision = "enabled" | "declined";

export type RecoveryStatus = {
	/** Undefined until the user has been asked */
	decision?: RecoveryDecision;
	/** How the run is started, once it has been registered */
	mechanism?: string;
};

export type DecideDeps = {
	stateRoot: string;
	platform: NodeJS.Platform;
	home: string;
	/** The Electron binary to run the check with */
	electron: string;
	run?: Parameters<typeof installSchedule>[0]["run"];
};

export const recoveryStatus = async (stateRoot: string): Promise<RecoveryStatus> => {
	const state = await readLunaState(stateRoot);
	return { decision: state?.updateRecovery, mechanism: state?.schedule?.mechanism };
};

/** The state with an answer recorded, keeping everything else it holds */
const withDecision = (state: LunaState, decision: RecoveryDecision): LunaState => ({ ...state, updateRecovery: decision });

/**
 * Records the user's answer and, when they said yes, registers the schedule.
 *
 * Answering again replaces the answer: someone who declines after enabling gets the task taken back off the machine.
 */
export const decideUpdateRecovery = async (
	deps: DecideDeps & { decision: RecoveryDecision },
): Promise<ScheduleOutcome & { decision: RecoveryDecision }> => {
	const state = await readLunaState(deps.stateRoot);
	if (state === undefined)
		return { installed: false, mechanism: "none", decision: deps.decision, reason: "Luna has no record of being installed here" };

	if (deps.decision === "declined") {
		const removed = await removeSchedule({ platform: deps.platform, home: deps.home, run: deps.run ?? execRunner });
		const next = { ...withDecision(state, "declined"), schedule: undefined };
		await writeLunaState(deps.stateRoot, next);
		return { ...removed, decision: "declined", reason: `declined; ${removed.reason}` };
	}

	const scheduled = await installSchedule({
		platform: deps.platform,
		stateRoot: deps.stateRoot,
		home: deps.home,
		electron: deps.electron,
		run: deps.run ?? execRunner,
	});
	// The answer is kept even when registering failed: it is what the user decided, and the next start retries
	await writeLunaState(deps.stateRoot, {
		...withDecision(state, "enabled"),
		schedule: scheduled.installed ? { mechanism: scheduled.mechanism, installedAt: new Date().toISOString() } : undefined,
	});
	return { ...scheduled, decision: "enabled" };
};

/**
 * The boot side: completes a decision that was made but not yet registered, and does nothing otherwise.
 *
 * In particular it never registers anything on a machine that has not answered, which is what keeps this opt-in.
 */
export const applyRecordedDecision = async (deps: DecideDeps): Promise<ScheduleOutcome | undefined> => {
	const state = await readLunaState(deps.stateRoot);
	if (state?.updateRecovery !== "enabled" || state.schedule !== undefined) return undefined;
	const scheduled = await installSchedule({
		platform: deps.platform,
		stateRoot: deps.stateRoot,
		home: deps.home,
		electron: deps.electron,
		run: deps.run ?? execRunner,
	});
	if (!scheduled.installed) return scheduled;
	await writeLunaState(deps.stateRoot, { ...state, schedule: { mechanism: scheduled.mechanism, installedAt: new Date().toISOString() } });
	return scheduled;
};
