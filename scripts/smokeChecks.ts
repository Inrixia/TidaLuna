import { checkPatches } from "../render/src/tidalPatchCheck";

/**
 * The checks a TIDAL test instance can answer, as values.
 *
 * These are the same questions the agent scenarios in #312 ask, but the verdict is a comparison rather than a sentence
 * in a reply: `tidal.mjs eval` already prints `JSON.stringify(result.value)`, so each probe returns JSON and each check
 * here decides what that JSON means. Nothing in this file touches TIDAL, a network, or a model, so it is covered by
 * `smokeChecks.test.ts` on every PR; `smoke.ts` is the thin part that fills the observations in.
 */
export type Verdict = "pass" | "warn" | "fail";

export type CheckResult = {
	name: string;
	verdict: Verdict;
	/** One line, for a terminal or a CI log */
	detail: string;
};

/** What a run of `smoke.ts` collected from a live instance, or from a `--from` file */
export type Observations = {
	corePlugins?: {
		expected: string[];
		plugins: { name: string; enabled: boolean; loaded: boolean; loadError?: string }[];
	};
	tidalInternals?: { moduleCount: number; actionCount: number; storeKeys: number };
	/** TIDAL's renderer sources, as `tidal.mjs dump` writes them */
	patchSources?: string[];
	interceptor?: { pathname: string | null };
	/** The same read-only native call made from the page and from the main process */
	nativeBridge?: { page: unknown; native: unknown; nonCloneableError?: string };
	styleTag?: { applied: string | null; afterUnload: string | null };
	/** `Object.keys(luna.core.buildActions).sort()`, live */
	buildActions?: string[];
	/** Action types the repo's code refers to, read from source */
	usedActionTypes?: string[];
	media?: { title: string | null; artist: string | null; album: string | null; errors: string[] };
};

/** The thumbnails the scenario expected, kept here so a probe and its expectation cannot drift apart */
export const expectedCorePlugins = ["@luna/lib.native", "@luna/lib", "@luna/ui", "@luna/dev"];

/**
 * Floors for "the internals were captured at all", not a census of TIDAL. When the capture fails these are effectively
 * zero; `plugins/lib/src/redux/types/actions/actionTypes.ts`, which is a copy of `Object.keys(buildActions)`, has 695
 * entries, so a healthy instance is far above either floor.
 */
const minTidalModules = 100;
const minBuildActions = 100;

const fail = (name: string, detail: string): CheckResult => ({ name, verdict: "fail", detail });
const pass = (name: string, detail: string): CheckResult => ({ name, verdict: "pass", detail });
const warn = (name: string, detail: string): CheckResult => ({ name, verdict: "warn", detail });

export const checkCorePlugins = (plugins: Observations["corePlugins"]): CheckResult => {
	const name = "core plugins load";
	if (plugins === undefined) return fail(name, "no observation: the probe for this did not run");
	const expected = plugins.expected.length > 0 ? plugins.expected : expectedCorePlugins;
	const byName = new Map(plugins.plugins.map((plugin) => [plugin.name, plugin]));
	const missing = expected.filter((pluginName) => !byName.has(pluginName));
	const notLoaded = expected.filter((pluginName) => {
		const found = byName.get(pluginName);
		return found !== undefined && (!found.enabled || !found.loaded);
	});
	const errored = plugins.plugins.filter((plugin) => plugin.loadError !== undefined && plugin.loadError !== "");
	if (missing.length > 0) return fail(name, `not registered: ${missing.join(", ")}`);
	if (errored.length > 0) return fail(name, `loadError: ${errored.map(({ name: n, loadError }) => `${n} (${loadError})`).join(", ")}`);
	if (notLoaded.length > 0) return fail(name, `registered but not loaded: ${notLoaded.join(", ")}`);
	return pass(name, `${expected.length} loaded`);
};

export const checkTidalInternals = (internals: Observations["tidalInternals"]): CheckResult => {
	const name = "TIDAL internals captured";
	if (internals === undefined) return fail(name, "no observation: the probe for this did not run");
	const { moduleCount, actionCount, storeKeys } = internals;
	if (moduleCount < minTidalModules) return fail(name, `${moduleCount} modules captured, expected at least ${minTidalModules}`);
	if (actionCount < minBuildActions) return fail(name, `${actionCount} action creators captured, expected at least ${minBuildActions}`);
	if (storeKeys < 1) return fail(name, "the Redux store was found but its state has no keys");
	return pass(name, `${moduleCount} modules, ${actionCount} action creators, ${storeKeys} store keys`);
};

export const checkPatchesApply = (sources: Observations["patchSources"]): CheckResult => {
	const name = "TIDAL patches still apply";
	if (sources === undefined) return fail(name, "no observation: no dump was read");
	const results = checkPatches(sources);
	const broken = results.filter(({ state }) => state === "stale" || state === "noop");
	const absent = results.filter(({ state }) => state === "absent");
	if (broken.length > 0) return fail(name, broken.map(({ name: patch, state }) => `${patch} (${state})`).join(", "));
	// A patch whose module was never loaded is not evidence either way: a dump only has the pages that were opened
	if (absent.length > 0)
		return warn(name, `applied ${results.length - absent.length}/${results.length}; not loaded: ${absent.map(({ name: n }) => n).join(", ")}`);
	return pass(name, `all ${results.length} applied`);
};

export const checkInterceptor = (interceptor: Observations["interceptor"]): CheckResult => {
	const name = "interceptors run on TIDAL actions";
	if (interceptor === undefined) return fail(name, "no observation: the probe for this did not run");
	const { pathname } = interceptor;
	// The probe intercepts the router/NAVIGATED that TIDAL's own (patched) creator makes after a push
	if (pathname === null) return fail(name, "no router/NAVIGATED action arrived within 5s: interceptors are not seeing TIDAL's actions");
	if (pathname !== "/not-found") return fail(name, `the action carried ${JSON.stringify(pathname)}, expected "/not-found"`);
	return pass(name, `saw router/NAVIGATED for ${pathname}`);
};

/** Order-insensitive comparison, because a page and the main process need not serialise keys the same way */
const sameValue = (a: unknown, b: unknown): boolean => {
	const canonical = (value: unknown): string => {
		if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
		if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
		const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1));
		return `{${entries.map(([key, entry]) => `${key}:${canonical(entry)}`).join(",")}}`;
	};
	return canonical(a) === canonical(b);
};

export const checkNativeBridge = (bridge: Observations["nativeBridge"]): CheckResult => {
	const name = "native bridge round-trips";
	if (bridge === undefined) return fail(name, "no observation: the probe for this did not run");
	if (!sameValue(bridge.page, bridge.native))
		return fail(name, `page got ${JSON.stringify(bridge.page)}, main process got ${JSON.stringify(bridge.native)}`);
	// A value that cannot be structured-cloned must reject, not hang the renderer
	if (bridge.nonCloneableError === undefined) return fail(name, "a non-cloneable argument neither rejected nor errored: the call hung");
	return pass(name, `equal both sides; non-cloneable argument errored as it should`);
};

export const checkStyleTag = (styleTag: Observations["styleTag"]): CheckResult => {
	const name = "StyleTag applies and unloads";
	if (styleTag === undefined) return fail(name, "no observation: the probe for this did not run");
	const { applied, afterUnload } = styleTag;
	// The probe sets `body { outline: 3px solid red }` and reads back getComputedStyle(document.body).outlineStyle
	if (applied !== "solid") return fail(name, `the style did not apply: outlineStyle was ${JSON.stringify(applied)}, expected "solid"`);
	if (afterUnload !== "" && afterUnload !== "none")
		return fail(name, `the style survived unload: outlineStyle was ${JSON.stringify(afterUnload)}`);
	return pass(name, "applied, then removed by unloadSet");
};

/**
 * The committed `actionTypes` array is `Object.keys(buildActions).sort()` copied out of TIDAL, so the live list must
 * contain every entry that the repo's own code refers to. What TIDAL adds is a note for whoever updates the array; what
 * it drops is a failure, because a type the code still names would only fail at runtime.
 */
export const checkActionTypes = (buildActions: Observations["buildActions"], usedActionTypes: Observations["usedActionTypes"]): CheckResult => {
	const name = "TIDAL action types still exist";
	if (buildActions === undefined) return fail(name, "no observation: the probe for this did not run");
	const live = new Set(buildActions);
	const used = usedActionTypes ?? [];
	const missing = used.filter((type) => !live.has(type));
	if (missing.length > 0) return fail(name, `used by this repo but gone from TIDAL: ${missing.join(", ")}`);
	return pass(name, `${used.length} types used in code all exist in TIDAL's ${live.size}`);
};

/**
 * Compared against the committed snapshot, this is the drift report: what TIDAL added or removed since
 * `plugins/lib/src/redux/types/actions/actionTypes.ts` was last regenerated.
 */
export const diffActionTypes = (buildActions: readonly string[], committed: readonly string[]): { added: string[]; removed: string[] } => {
	const live = new Set(buildActions);
	const known = new Set(committed);
	return {
		added: [...live].filter((type) => !known.has(type)).sort(),
		removed: [...known].filter((type) => !live.has(type)).sort(),
	};
};

export const checkFingerprint = (buildActions: Observations["buildActions"], committed: readonly string[]): CheckResult => {
	const name = "TIDAL action types match the committed snapshot";
	if (buildActions === undefined) return fail(name, "no observation: the probe for this did not run");
	const { added, removed } = diffActionTypes(buildActions, committed);
	if (removed.length > 0 || added.length > 0) {
		// Not a failure on its own: it means actionTypes.ts should be regenerated, which is a reviewable diff, not a bug
		const parts = [
			removed.length > 0 ? `removed ${removed.length} (${removed.slice(0, 5).join(", ")})` : "",
			added.length > 0 ? `added ${added.length} (${added.slice(0, 5).join(", ")})` : "",
		];
		return warn(name, `${parts.filter(Boolean).join("; ")} - regenerate actionTypes.ts`);
	}
	return pass(name, `${buildActions.length} types, no drift`);
};

/** Login-dependent, so it runs only when the instance has a session. No playback: these are metadata reads. */
export const checkMediaData = (media: Observations["media"]): CheckResult => {
	const name = "@luna/lib reads real media data";
	if (media === undefined) return warn(name, "skipped: no observation (needs a logged-in instance)");
	if (media.errors.length > 0) return fail(name, `threw: ${media.errors.join(", ")}`);
	const empty = (["title", "artist", "album"] as const).filter((field) => media[field] === null || media[field] === "");
	if (empty.length > 0) return fail(name, `returned nothing for ${empty.join(", ")} where TIDAL has the data`);
	return pass(name, `${JSON.stringify(media.title)} by ${JSON.stringify(media.artist)} on ${JSON.stringify(media.album)}`);
};

/** Every check, in the order a run reports them. A missing observation fails, so a skipped probe cannot look like a pass. */
export const runChecks = (observations: Observations, committedActionTypes: readonly string[] = []): CheckResult[] => [
	checkCorePlugins(observations.corePlugins),
	checkTidalInternals(observations.tidalInternals),
	checkPatchesApply(observations.patchSources),
	checkInterceptor(observations.interceptor),
	checkNativeBridge(observations.nativeBridge),
	checkStyleTag(observations.styleTag),
	checkActionTypes(observations.buildActions, observations.usedActionTypes),
	...(committedActionTypes.length > 0 ? [checkFingerprint(observations.buildActions, committedActionTypes)] : []),
	checkMediaData(observations.media),
];

/** Exit code for a run: warns are notes, only failures fail */
export const exitCodeFor = (results: readonly CheckResult[]): number => (results.some(({ verdict }) => verdict === "fail") ? 1 : 0);
