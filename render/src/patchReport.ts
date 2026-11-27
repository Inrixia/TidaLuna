import { tidalPatches, type Patch, type PatchOutcome } from "./tidalPatches";

/**
 * Whether TIDAL's code still matches the patches Luna carries, learned as TIDAL's modules load.
 *
 * `applyTidalPatches` skips a patch whose marker is present but whose pattern no longer matches, and says nothing, so a
 * TIDAL update can quietly remove a fix. Every module TIDAL loads is a chance to record whether each patch still
 * applies, which saves dumping TIDAL's sources to find out.
 *
 * The repair decision reads the result: `stale` means this Luna was written for a different TIDAL, so the fix is a newer
 * Luna, not the same one again.
 */

export type PatchState = "applied" | "noop" | "stale" | "unseen";

export type PatchStatus = {
	name: string;
	state: PatchState;
	/** How many of TIDAL's modules carried this patch's marker */
	modules: number;
};

type Tally = { applied: number; noop: number; stale: number; modules: number };

export class PatchReport {
	private readonly tallies = new Map<string, Tally>();

	/** Feed one transformed module's result. Bound, so it can be passed straight to `applyTidalPatches` */
	public readonly observe = (patch: Patch, outcome: PatchOutcome) => {
		const tally = this.tallies.get(patch.name) ?? { applied: 0, noop: 0, stale: 0, modules: 0 };
		if (outcome === "absent") {
			this.tallies.set(patch.name, tally);
			return;
		}
		tally.modules++;
		if (outcome === "applied") tally.applied++;
		if (outcome === "noop") tally.noop++;
		if (outcome === "stale") tally.stale++;
		this.tallies.set(patch.name, tally);
	};

	/**
	 * One status per patch Luna carries. `applied` if any module took it; `stale` if a module carried the marker and none
	 * took it; `noop` if it matched but changed nothing; `unseen` if no module has loaded the code it targets yet.
	 */
	public statuses(): PatchStatus[] {
		return tidalPatches.map(({ name }) => {
			const tally = this.tallies.get(name);
			if (tally === undefined || tally.modules === 0) return { name, state: "unseen" as const, modules: 0 };
			const state: PatchState = tally.applied > 0 ? "applied" : tally.stale > 0 ? "stale" : tally.noop > 0 ? "noop" : "unseen";
			return { name, state, modules: tally.modules };
		});
	}

	/** True when every patch Luna carries applied to the TIDAL that is running */
	public get allApplied(): boolean {
		return this.statuses().every(({ state }) => state === "applied" || state === "unseen");
	}

	/** The patches that did not apply, which is the part worth reporting */
	public get problems(): PatchStatus[] {
		return this.statuses().filter(({ state }) => state === "stale" || state === "noop");
	}

	public reset() {
		this.tallies.clear();
	}
}

/** The report for this process: TIDAL has one set of modules, so one report describes it */
export const patchReport = new PatchReport();
