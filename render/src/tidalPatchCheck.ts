import { tidalPatches, type Patch } from "./tidalPatches";

/** What a check of one patch against the code TIDAL ships found */
export type PatchStatus = {
	name: string;
	/**
	 * `applied`: the code this patch was written for is there and the patch changes it.
	 * `stale`: the module is there but the pattern no longer matches, so the fix is silently missing.
	 * `noop`: the pattern matched but the replacement changes nothing, so the fix is silently missing.
	 * `absent`: no source contains the marker, so the module has not loaded (or TIDAL renamed it).
	 */
	state: "applied" | "stale" | "noop" | "absent";
	/** Sources whose marker says they are the module this patch was written for */
	sources: number;
};

/**
 * Whether `patch` matches `source`. A copy without `g`, because `RegExp.test` carries `lastIndex` between calls when a
 * regex is global, so checking many sources with the patch's own regex could skip every other one.
 */
const matches = (patch: Patch, source: string) => new RegExp(patch.find.source, patch.find.flags.replace("g", "")).test(source);

/**
 * Whether `patch` still applies to the sources it was written for.
 *
 * `applyTidalPatches` skips a patch whose marker is present but whose pattern does not match, and logs nothing, so after
 * a TIDAL update the perf fix it carries just disappears. This asks the same question as a value instead.
 */
export const checkPatch = (patch: Patch, sources: readonly string[]): PatchStatus => {
	const candidates = sources.filter((source) => source.includes(patch.marker));
	if (candidates.length === 0) return { name: patch.name, state: "absent", sources: 0 };
	// Compared as applying it does, so a replacement that refers to a group it does not have is caught too
	const changed = candidates.some((source) => source.replace(patch.find, patch.replace) !== source);
	if (changed) return { name: patch.name, state: "applied", sources: candidates.length };
	return { name: patch.name, state: candidates.some((source) => matches(patch, source)) ? "noop" : "stale", sources: candidates.length };
};

/** Every patch, checked against `sources` (the TIDAL modules a test instance dumped) */
export const checkPatches = (sources: readonly string[]): PatchStatus[] => tidalPatches.map((patch) => checkPatch(patch, sources));
