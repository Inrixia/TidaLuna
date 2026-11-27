import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";

import { actionTypes } from "../plugins/lib/src/redux/types/actions/actionTypes";
import { scanUsedActionTypes } from "./usedActionTypes";

/**
 * `scripts/smoke.ts --from` end to end: a saved run replayed gives the same verdicts and the same exit code, with no
 * TIDAL, no network and no login. That is what makes this a deterministic suite rather than an agent session - the
 * tool itself is covered by CI, not just the checks it calls.
 */
const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..");
const tsx = path.join(repo, "node_modules", "tsx", "dist", "cli.mjs");
const cli = path.join(repo, "scripts", "smoke.ts");

const sources = [
	String.raw`var x=function(){return"dragSource:("},n={dragSource:(e,t)=>{this.clearDragSource(),e===t&&this.reconnectDragSource()},y:1};`,
	String.raw`const q={threshold:0,delay:0,trackVisibility:0,rootMargin:r,root:e,triggerOnce:F,a:1},s=0;s.useEffect(()=>{if(G.current===void 0&&(G.current=H),I||!J)return;`,
	String.raw`const g=(t)=>{const s=e=>{let a=b.current;if(c.valid(a))return;let d=()=>b.current=c(t)};return s};t.setAttribute("data-overlayscrollbars-initialize","");`,
];

const plugins = (drop?: string) => ({
	expected: ["@luna/lib.native", "@luna/lib", "@luna/ui", "@luna/dev"],
	plugins: ["@luna/lib.native", "@luna/lib", "@luna/ui", "@luna/dev"]
		.filter((name) => name !== drop)
		.map((name) => ({ name, enabled: true, loaded: true })),
});

let dir: string;
let used: string[];

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "luna-smoke-"));
	used = [...(await scanUsedActionTypes(repo)).keys()];
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** Runs the CLI against `observations` and returns what it printed with its exit code */
const replay = async (observations: unknown) => {
	const file = path.join(dir, "observations.json");
	await writeFile(file, JSON.stringify(observations));
	try {
		const { stdout } = await run(process.execPath, [tsx, cli, "--from", file], { cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
		return { stdout, status: 0 };
	} catch (err) {
		const failed = err as { stdout?: string; code?: number };
		return { stdout: failed.stdout ?? "", status: failed.code ?? 1 };
	}
};

/** An instance that is healthy: every probe agreed */
const healthy = () => ({
	corePlugins: plugins(),
	tidalInternals: { moduleCount: 412, actionCount: actionTypes.length, storeKeys: 14 },
	patchSources: sources,
	interceptor: { pathname: "/not-found" },
	nativeBridge: { page: { path: "x", usage: 0 }, native: { usage: 0, path: "x" }, nonCloneableError: "An object could not be cloned." },
	styleTag: { applied: "solid", afterUnload: "" },
	buildActions: [...actionTypes],
	usedActionTypes: used,
	media: { title: "Track", artist: "Artist", album: "Album", errors: [] },
});

test("a healthy instance passes and exits 0", async () => {
	const { stdout, status } = await replay(healthy());

	expect(status).toBe(0);
	expect(stdout).toContain("pass core plugins load");
	expect(stdout).toContain("pass TIDAL patches still apply");
	expect(stdout).toContain("0 failed");
});

test("a broken instance fails every check, names each one, and exits 1", async () => {
	const broken = {
		...healthy(),
		corePlugins: plugins("@luna/ui"),
		tidalInternals: { moduleCount: 2, actionCount: 3, storeKeys: 0 },
		patchSources: sources.map((source) => source.replace("c.valid(a)", "c.isValid(a)")),
		interceptor: { pathname: null },
		nativeBridge: { page: { a: 1 }, native: { a: 2 } },
		styleTag: { applied: "solid", afterUnload: "solid" },
		buildActions: [...actionTypes].filter((type) => type !== used[0]),
		media: { title: null, artist: null, album: null, errors: ["title() threw"] },
	};
	const { stdout, status } = await replay(broken);

	expect(status).toBe(1);
	// The point of the whole thing: the failure says which check, and why
	expect(stdout).toContain("not registered: @luna/ui");
	expect(stdout).toContain("OverlayScrollbars to native scrolling (stale)");
	expect(stdout).toContain("no router/NAVIGATED action arrived");
	// Shapes, not values: this output is uploaded from a machine logged into a real account
	expect(stdout).toContain("main process sent {a}");
	expect(stdout).toContain("the style survived unload");
});

test("a missing observation fails rather than passing quietly", async () => {
	// A probe that could not run must not look like a working app
	const { stdout, status } = await replay({});

	expect(status).toBe(1);
	expect(stdout).toContain("no observation");
});

test("replaying the same observations twice gives the same output", async () => {
	// The property an agent verdict cannot offer
	const first = await replay(healthy());
	const second = await replay(healthy());
	expect(second.stdout).toBe(first.stdout);
});
