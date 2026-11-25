import { describe, expect, test } from "vitest";

import { applyTidalPatches, tidalPatches } from "./tidalPatches";
import { checkPatch, checkPatches } from "./tidalPatchCheck";

/**
 * TIDAL's bundled code is not in this repo, so each patch gets a source shaped like the code it was written against: the
 * same minified shapes, plus the marker its module also contains. That is enough to answer the question the agent tests
 * were invented for - does this fix still match the code TIDAL ships? - as a value, with no instance, no network, no
 * login and nothing to judge.
 *
 * The bug these pin: `applyTidalPatches` skips a patch whose marker is present but whose pattern no longer matches, and
 * logs nothing. The checks below fail loudly on exactly that.
 */
const shaped: Record<string, { source: string; applied: string }> = {
	"react-dnd dragSource ref churn": {
		// dragSource:(e,t)=>{this.clearDragSource(),e===t&&this.reconnectDragSource()}
		source: `var x=function(){return"dragSource:("},n={dragSource:(e,t)=>{this.clearDragSource(),e===t&&this.reconnectDragSource()},y:1};`,
		applied: "queueMicrotask(()=>this.reconnectDragSource())",
	},
	"react-intersection-observer triggerOnce re-observe": {
		// {threshold:0,...,triggerOnce:F,a:1},...s.useEffect(()=>{if(G.current===void 0&&(G.current=H),I||!J)return;
		source: `const q={threshold:0,delay:0,trackVisibility:0,rootMargin:r,root:e,triggerOnce:F,a:1},s=0;s.useEffect(()=>{if(G.current===void 0&&(G.current=H),I||!J)return;`,
		applied: "||F&&G.current)return;",
	},
	"OverlayScrollbars to native scrolling": {
		// e=>{let a=b.current;if(c.valid(a))return;let d=()=>b.current=c(
		source: `const g=(t)=>{const s=e=>{let a=b.current;if(c.valid(a))return;let d=()=>b.current=c(t)};return s};t.setAttribute("data-overlayscrollbars-initialize","");`,
		applied: "b.current=globalThis.__lunaNativeScroll(",
	},
};

describe("tidal patches", () => {
	test("every patch is still checked, so a new one cannot go uncovered", () => {
		// A patch added without a source shaped like its code is a patch nobody is watching
		expect(Object.keys(shaped).sort()).toEqual(tidalPatches.map(({ name }) => name).sort());
	});

	for (const patch of tidalPatches) {
		test(`still matches the code shape it was written for: ${patch.name}`, () => {
			const { source, applied } = shaped[patch.name];

			// The marker is what makes applyTidalPatches try the pattern at all
			expect(source).toContain(patch.marker);
			expect(checkPatch(patch, [source]).state).toBe("applied");
			// And it really rewrites the code, rather than matching and putting the same text back
			expect(applyTidalPatches(source)).toContain(applied);
			expect(applyTidalPatches(source)).not.toBe(source);
		});
	}

	test("a patch whose pattern stopped matching is reported, not skipped", () => {
		const [patch] = tidalPatches;
		// What a TIDAL update looks like: the marker is still there, the call it targeted was renamed
		const updated = shaped[patch.name].source.replace("this.reconnectDragSource()}", "this.reconnectDragSource2()}");

		// This is the bug: the fix is gone and nothing says so
		expect(applyTidalPatches(updated)).toBe(updated);
		// This is the fix: the same fact, as a value a test can fail on
		expect(checkPatch(patch, [updated])).toEqual({ name: patch.name, state: "stale", sources: 1 });
	});

	test("a marker in an unloaded module is absent rather than stale", () => {
		// Nav-dependent modules are not in a dump until the page that uses them is opened
		const absent = checkPatches([]);

		expect(absent).toHaveLength(tidalPatches.length);
		expect(absent.every(({ state }) => state === "absent")).toBe(true);
		// Absent must be distinguishable from broken, or a partial dump cries wolf
		expect(checkPatches(Object.values(shaped).map(({ source }) => source)).every(({ state }) => state === "applied")).toBe(true);
	});

	test("reports a replacement that changes nothing", () => {
		// Pattern says yes, the fix is already what is there (or the replacement is just `$1`): nothing changes
		const pointless = { name: "identical replacement", marker: "MARK", find: /MARK:\d+/, replace: "$&" };

		expect(checkPatch(pointless, ["MARK:7"]).state).toBe("noop");
		// And one that does change it
		expect(checkPatch({ ...pointless, replace: "MARK:8" }, ["MARK:7"]).state).toBe("applied");
	});

	test("leaves code it has no patch for alone", () => {
		const unrelated = `const a={threshold:1},b=useState();function c(){return a.x+b}`;

		expect(applyTidalPatches(unrelated)).toBe(unrelated);
	});

	test("applying twice gives what applying once gives", () => {
		// tidalTransform runs per module load; a patch that re-fires would wrap the fix again
		for (const { source } of Object.values(shaped)) {
			const once = applyTidalPatches(source);
			expect(applyTidalPatches(once)).toBe(once);
		}
	});

	test("names and markers are unique", () => {
		// Both are keys: names label a failure, markers decide which modules a patch is tried against
		expect(new Set(tidalPatches.map(({ name }) => name)).size).toBe(tidalPatches.length);
		expect(new Set(tidalPatches.map(({ marker }) => marker)).size).toBe(tidalPatches.length);
	});

	test("no patch uses a global regex, so a check cannot carry lastIndex between sources", () => {
		for (const patch of tidalPatches) expect(patch.find.flags).not.toContain("g");
	});
});
