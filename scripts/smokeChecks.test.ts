import { describe, expect, test } from "vitest";

import { tidalPatches } from "../render/src/tidalPatches";
import {
	checkActionTypes,
	checkCorePlugins,
	checkFingerprint,
	checkInterceptor,
	checkMediaData,
	checkNativeBridge,
	checkPatchesApply,
	checkStyleTag,
	checkTidalInternals,
	diffActionTypes,
	exitCodeFor,
	expectedCorePlugins,
	runChecks,
	type CheckResult,
	type Observations,
} from "./smokeChecks";

/**
 * The verdicts the smoke probes depend on, decided here instead of by a model reading a reply.
 *
 * Each check gets a passing case and the cases it exists to catch: a checker that cannot fail is worth nothing, which is
 * the whole reason #312's `RESULT: PASS` regex is not good enough.
 */
const plugins = (overrides: Partial<{ name: string; enabled: boolean; loaded: boolean; loadError?: string }>[] = []) => ({
	expected: expectedCorePlugins,
	plugins: expectedCorePlugins.map((name) => ({ name, enabled: true, loaded: true, ...overrides?.find(({ name: n }) => n === name) })),
});

/** A source shaped like the code each patch was written for, so the patch check has something real to decide on */
const patchSources = () => [
	`var x=function(){return"dragSource:("},n={dragSource:(e,t)=>{this.clearDragSource(),e===t&&this.reconnectDragSource()},y:1};`,
	`const q={threshold:0,delay:0,trackVisibility:0,rootMargin:r,root:e,triggerOnce:F,a:1},s=0;s.useEffect(()=>{if(G.current===void 0&&(G.current=H),I||!J)return;`,
	`const g=(t)=>{const s=e=>{let a=b.current;if(c.valid(a))return;let d=()=>b.current=c(t)};return s};t.setAttribute("data-overlayscrollbars-initialize","");`,
];

describe("checks report a pass only when the probe agreed", () => {
	test("core plugins", () => {
		expect(checkCorePlugins(plugins()).verdict).toBe("pass");
		// Nothing observed is never a pass: a probe that did not run must not look like a working app
		expect(checkCorePlugins(undefined).verdict).toBe("fail");
	});

	test("core plugins that are missing, disabled, unloaded or errored all fail", () => {
		const missing = plugins().plugins.filter(({ name }) => name !== "@luna/ui");
		expect(checkCorePlugins({ expected: expectedCorePlugins, plugins: missing })).toMatchObject({ verdict: "fail" });
		expect(checkCorePlugins(plugins([{ name: "@luna/dev", enabled: false }])).detail).toContain("not loaded");
		expect(checkCorePlugins(plugins([{ name: "@luna/dev", loaded: false }])).verdict).toBe("fail");
		expect(checkCorePlugins(plugins([{ name: "@luna/lib", loadError: "boom" }])).detail).toContain("boom");
	});

	test("TIDAL internals", () => {
		expect(checkTidalInternals({ moduleCount: 400, actionCount: 1800, storeKeys: 12 }).verdict).toBe("pass");
		expect(checkTidalInternals(undefined).verdict).toBe("fail");
		// Orders of magnitude off is what "internals were not captured" looks like
		expect(checkTidalInternals({ moduleCount: 3, actionCount: 1800, storeKeys: 12 }).verdict).toBe("fail");
		expect(checkTidalInternals({ moduleCount: 400, actionCount: 40, storeKeys: 12 }).verdict).toBe("fail");
		expect(checkTidalInternals({ moduleCount: 400, actionCount: 1800, storeKeys: 0 }).verdict).toBe("fail");
	});

	test("patches apply", () => {
		expect(checkPatchesApply(patchSources()).verdict).toBe("pass");
		expect(checkPatchesApply(undefined).verdict).toBe("fail");
	});

	test("a patch that stopped matching fails and is named", () => {
		// What a TIDAL update looks like: the marker survives, the call the patch targeted was renamed
		const reshaped = patchSources().map((source) => source.replace("c.valid(a)", "c.isValid(a)"));
		const result = checkPatchesApply(reshaped);

		expect(result.verdict).toBe("fail");
		expect(result.detail).toContain("OverlayScrollbars to native scrolling");
		expect(result.detail).toContain("stale");
	});

	test("a patch whose module never loaded is a warning, not a failure", () => {
		// A dump only holds the pages that were opened; that is missing evidence, not a broken fix
		const result = checkPatchesApply([patchSources()[0]]);

		expect(result.verdict).toBe("warn");
		expect(result.detail).toContain("not loaded");
	});

	test("interceptors", () => {
		expect(checkInterceptor({ pathname: "/not-found" }).verdict).toBe("pass");
		expect(checkInterceptor(undefined).verdict).toBe("fail");
		// null is the probe's "nothing arrived in 5s"
		expect(checkInterceptor({ pathname: null }).verdict).toBe("fail");
		expect(checkInterceptor({ pathname: "/album/1" }).verdict).toBe("fail");
	});

	test("native bridge compares values regardless of key order", () => {
		expect(checkNativeBridge({ page: { a: 1, b: [1, 2] }, native: { b: [1, 2], a: 1 }, nonCloneableError: "DataCloneError" }).verdict).toBe(
			"pass",
		);
		expect(checkNativeBridge(undefined).verdict).toBe("fail");
		expect(checkNativeBridge({ page: { a: 1 }, native: { a: 2 }, nonCloneableError: "x" }).verdict).toBe("fail");
		// No rejection means the renderer hung on a value it could not clone
		expect(checkNativeBridge({ page: 1, native: 1 }).verdict).toBe("fail");
	});

	test("StyleTag is checked on the computed style, and on it being gone after unload", () => {
		expect(checkStyleTag({ applied: "solid", afterUnload: "" }).verdict).toBe("pass");
		expect(checkStyleTag({ applied: "solid", afterUnload: "none" }).verdict).toBe("pass");
		expect(checkStyleTag(undefined).verdict).toBe("fail");
		expect(checkStyleTag({ applied: "none", afterUnload: "" }).verdict).toBe("fail");
		expect(checkStyleTag({ applied: "solid", afterUnload: "solid" }).verdict).toBe("fail");
	});

	test("action types used in code must exist in TIDAL", () => {
		expect(checkActionTypes(["router/PUSH", "router/NAVIGATED"], ["router/PUSH"]).verdict).toBe("pass");
		expect(checkActionTypes(undefined, []).verdict).toBe("fail");
		expect(checkActionTypes(["router/NAVIGATED"], ["router/PUSH"]).detail).toContain("router/PUSH");
	});

	test("drift against the committed snapshot is a note, and says what moved", () => {
		const committed = ["a/ONE", "a/TWO"];
		expect(checkFingerprint(["a/ONE", "a/TWO"], committed).verdict).toBe("pass");

		const drifted = checkFingerprint(["a/ONE", "a/THREE"], committed);
		expect(drifted.verdict).toBe("warn");
		expect(drifted.detail).toContain("removed 1 (a/TWO)");
		expect(drifted.detail).toContain("added 1 (a/THREE)");
		expect(diffActionTypes(["a/ONE", "a/THREE"], committed)).toEqual({ added: ["a/THREE"], removed: ["a/TWO"] });
	});

	test("media data", () => {
		expect(checkMediaData({ title: "T", artist: "A", album: "B", errors: [] }).verdict).toBe("pass");
		expect(checkMediaData({ title: null, artist: "A", album: "B", errors: [] }).detail).toContain("title");
		expect(checkMediaData({ title: "T", artist: "A", album: "B", errors: ["lyrics() threw"] }).verdict).toBe("fail");
		// Login-dependent, so an unobserved run is a skip rather than a red build
		expect(checkMediaData(undefined).verdict).toBe("warn");
	});
});

describe("a whole run", () => {
	test("every observation missing fails everything, rather than passing quietly", () => {
		const results = runChecks({});

		expect(results.filter(({ verdict }) => verdict === "fail")).toHaveLength(results.length - 1);
		// Only the login-dependent one may be skipped
		expect(results.filter(({ verdict }) => verdict === "warn").map(({ name }) => name)).toEqual(["@luna/lib reads real media data"]);
		expect(exitCodeFor(results)).toBe(1);
	});

	test("a healthy instance passes, and warns are not failures", () => {
		const observations: Observations = {
			corePlugins: plugins(),
			tidalInternals: { moduleCount: 400, actionCount: 1800, storeKeys: 12 },
			patchSources: patchSources(),
			interceptor: { pathname: "/not-found" },
			nativeBridge: { page: { pkg: "luna" }, native: { pkg: "luna" }, nonCloneableError: "DataCloneError" },
			styleTag: { applied: "solid", afterUnload: "" },
			buildActions: ["router/PUSH", "router/NAVIGATED"],
			usedActionTypes: ["router/PUSH"],
			media: { title: "T", artist: "A", album: "B", errors: [] },
		};
		const results = runChecks(observations, ["router/PUSH"]);

		expect(results.every(({ verdict }) => verdict !== "fail")).toBe(true);
		expect(exitCodeFor(results)).toBe(0);
	});

	test("one failure decides the exit code, warnings alone do not", () => {
		const warnsOnly: CheckResult[] = [
			{ name: "a", verdict: "warn", detail: "" },
			{ name: "b", verdict: "pass", detail: "" },
		];
		expect(exitCodeFor(warnsOnly)).toBe(0);
		expect(exitCodeFor([...warnsOnly, { name: "c", verdict: "fail", detail: "" }])).toBe(1);
	});

	test("the fingerprint check only runs when a snapshot was passed", () => {
		expect(runChecks({}).map(({ name }) => name)).not.toContain("TIDAL action types match the committed snapshot");
		expect(runChecks({ buildActions: [] }, ["a/ONE"]).map(({ name }) => name)).toContain("TIDAL action types match the committed snapshot");
	});

	test("every patch the repo ships is visible to the patch check", () => {
		// The check iterates the real list, so this pins that a new patch cannot be added without being checked
		const result = checkPatchesApply(patchSources());
		expect(tidalPatches).toHaveLength(3);
		expect(result.detail).toContain("all 3 applied");
	});
});
