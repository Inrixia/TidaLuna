/**
 * Checks a TIDAL test instance and reports a verdict per check. The deterministic counterpart to the agent scenarios in
 * #312: every probe returns JSON from `tidal.mjs eval`, and `smokeChecks.ts` decides what that JSON means.
 *
 *   pnpm exec tsx scripts/smoke.ts                  # drive a live instance (needs `.tidal-test/1`)
 *   pnpm exec tsx scripts/smoke.ts --from obs.json  # replay observations, no TIDAL needed
 *   pnpm exec tsx scripts/smoke.ts --keep           # leave the instance running afterwards
 *
 * `--from` exists so the whole pipeline can be exercised in CI without TIDAL, and so a failing run can be replayed from
 * the observations it saved. Nothing here is sampled: the same observations always give the same verdict.
 */
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { actionTypes } from "../plugins/lib/src/redux/types/actions/actionTypes";
import { scanUsedActionTypes } from "./usedActionTypes";
import { exitCodeFor, runChecks, type Observations } from "./smokeChecks";

const repo = path.resolve(import.meta.dirname, "..");
const tidal = path.join(repo, ".claude", "skills", "tidal-test-instance", "tidal.mjs");

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string): string => {
	const at = args.indexOf(`--${name}`);
	if (at === -1) return fallback;
	const value = args[at + 1];
	if (value === undefined) throw new Error(`--${name} needs a value`);
	return value;
};

const instance = option("instance", "1");
const from = option("from", "");
const out = option("out", path.join(repo, ".tidal-test", "smoke"));

/** Runs one `tidal.mjs` command and returns its stdout, or throws with what it printed */
const tidalRun = (command: string, expression?: string): string => {
	const argv = [tidal, "--instance", instance, command, ...(expression === undefined ? [] : [expression])];
	const run = spawnSync(process.execPath, argv, { cwd: repo, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
	if (run.error !== undefined) throw new Error(run.error.message);
	if (run.status !== 0) throw new Error(`${command} exited ${run.status}: ${(run.stderr || run.stdout || "").trim().slice(0, 400)}`);
	return run.stdout;
};

/**
 * Evaluates `expression` in the page and parses the JSON `tidal.mjs eval` prints. A probe that throws, prints nothing,
 * or prints something unparseable is left undefined, which the matching check reports as a failure: a broken probe must
 * never look like a passing one.
 */
const probe = (expression: string): unknown => {
	const stdout = tidalRun("eval", expression);
	try {
		return JSON.parse(stdout);
	} catch {
		return undefined;
	}
};

/** Probes whose value is compared as-is. Each runs in the page unless it says otherwise. */
const corePluginsProbe = `(async () => {
	const expected = ["@luna/lib.native", "@luna/lib", "@luna/ui", "@luna/dev", ...(__platform === "linux" ? ["@luna/linux"] : [])];
	const settled = (name) => Object.values(luna.core.LunaPlugin.plugins).some((p) => p.name === name && (luna.core.modules[name] !== undefined || p.loadError._ !== undefined));
	for (let waited = 0; waited < 20000 && !expected.every(settled); waited += 250) await new Promise((r) => setTimeout(r, 250));
	return {
		expected,
		plugins: Object.values(luna.core.LunaPlugin.plugins).map((p) => ({ name: p.name, enabled: p.enabled, loaded: luna.core.modules[p.name] !== undefined, loadError: p.loadError._ })),
	};
})()`;

const tidalInternalsProbe = `({
	moduleCount: Object.keys(luna.core.tidalModules).length,
	actionCount: Object.keys(luna.core.buildActions).length,
	storeKeys: typeof luna.core.reduxStore.getState === "function" ? Object.keys(luna.core.reduxStore.getState()).length : 0,
})`;

const buildActionsProbe = `Object.keys(luna.core.buildActions).sort()`;

/** Pushes a route and intercepts the router/NAVIGATED TIDAL's own creator makes, then removes the interceptor */
const interceptorProbe = `(() => {
	const unloads = new Set();
	return new Promise((resolve) => {
		luna.lib.redux.intercept("router/NAVIGATED", unloads, (payload) => resolve({ pathname: payload?.location?.pathname ?? payload?.pathname ?? null }));
		try { luna.lib.redux.actions["router/PUSH"]({ pathname: "/not-found", search: "lunaSmoke", replace: true }); } catch { resolve({ pathname: null }); }
		setTimeout(() => resolve({ pathname: null }), 5000);
	}).finally(() => { luna.core.unloadSet(unloads); luna.lib.redux.actions["router/PUSH"]({ pathname: "/", search: "", replace: true }); });
})()`;

/** StyleTag applies `outline: solid`, and unloadSet must take it away again */
const styleTagProbe = `(() => {
	const unloads = new Set();
	new luna.lib.StyleTag("luna-smoke", unloads, "body { outline: 3px solid red }");
	const applied = getComputedStyle(document.body).outlineStyle;
	luna.core.unloadSet(unloads);
	return { applied, afterUnload: getComputedStyle(document.body).outlineStyle };
})()`;

/**
 * The same read-only native call from the page (over IPC) and from the main process (direct), which is what the bridge
 * is: `offlineCacheStats` neither writes nor opens anything.
 */
const nativeBridgeProbe = `(async () => {
	const page = await luna.native.offlineCacheStats();
	const key = Object.keys(luna.modules).find((name) => name.includes("lib.native"));
	const native = key === undefined ? undefined : await luna.modules[key].offlineCacheStats();
	return { page, native };
})()`;

/** Login-dependent metadata reads. No playback: these are reads, and the rules for the instance still apply. */
const mediaProbe = `(async () => {
	const id = luna.lib.reduxStore.getState()?.content?.mediaItems?.[0]?.item?.id;
	if (id === undefined) return { skip: true };
	const errors = [];
	const read = async (label, fn) => { try { return await fn(); } catch (err) { errors.push(label + ": " + (err?.message ?? err)); return null; } };
	const item = await read("MediaItem.fromId", () => luna.lib.MediaItem.fromId(id));
	if (item === null) return { title: null, artist: null, album: null, errors };
	const title = await read("title()", () => item.title());
	const artist = await read("artist()", async () => (await item.artist())?.name ?? null);
	const album = await read("album()", async () => (await item.album())?.title ?? null);
	return { title: title ?? null, artist: artist ?? null, album: album ?? null, errors };
})()`;

const collect = async (): Promise<Observations> => {
	const observations: Observations = {};
	console.log(`Starting instance ${instance}...`);
	tidalRun("start");

	const step = <T>(label: string, read: () => T) => {
		try {
			return read();
		} catch (err) {
			// The check for it reports the missing observation; this only says why
			console.error(`${label}: ${(err as Error).message}`);
			return undefined;
		}
	};

	observations.corePlugins = step("core plugins", () => probe(corePluginsProbe) as Observations["corePlugins"]);
	observations.tidalInternals = step("TIDAL internals", () => probe(tidalInternalsProbe) as Observations["tidalInternals"]);
	observations.buildActions = step("buildActions", () => probe(buildActionsProbe) as string[]);
	observations.interceptor = step("interceptor", () => probe(interceptorProbe) as Observations["interceptor"]);
	observations.styleTag = step("StyleTag", () => probe(styleTagProbe) as Observations["styleTag"]);
	observations.nativeBridge = step("native bridge", () => {
		const both = probe(nativeBridgeProbe) as { page: unknown; native: unknown } | undefined;
		if (both === undefined) return undefined;
		// A function cannot survive structured cloning: the renderer must be told, not left waiting. null means it resolved
		const rejected = probe(`luna.native.offlineCacheStats(() => 1).then(() => null, (err) => String((err && err.message) || err))`);
		return { ...both, nonCloneableError: typeof rejected === "string" ? rejected : undefined };
	});
	observations.media = step("media data", () => probe(mediaProbe) as Observations["media"]);

	// The dump is a folder of TIDAL's served sources, which the patch check reads
	const dumped = step("dump", () => {
		tidalRun("dump", path.join(out, "sources"));
		return path.join(out, "sources");
	});
	if (dumped !== undefined) {
		observations.patchSources = await readdir(dumped, { recursive: true })
			.then(async (names) =>
				(await Promise.all(names.map((name) => readFile(path.join(dumped, String(name)), "utf8").catch(() => undefined)))).filter(
					(code): code is string => code !== undefined,
				),
			)
			.catch(() => undefined);
	}

	if (!flag("keep")) tidalRun("stop");
	return observations;
};

const observations = from === "" ? await collect() : (JSON.parse(await readFile(from, "utf8")) as Observations);
if (from === "") {
	await mkdir(out, { recursive: true });
	const saved = path.join(out, "observations.json");
	await writeFile(saved, JSON.stringify(observations, null, "\t"));
	console.log(`\nObservations saved to ${saved} (replay with --from ${path.relative(repo, saved)})\n`);
}

// What the repo names has to exist in TIDAL; the scan is static, so it needs no instance
observations.usedActionTypes = [...(await scanUsedActionTypes(repo)).keys()];

const results = runChecks(observations, actionTypes);
const width = Math.max(...results.map(({ name }) => name.length));
for (const { name, verdict, detail } of results) console.log(`${verdict.padEnd(4)} ${name.padEnd(width)}  ${detail}`);

const failed = results.filter(({ verdict }) => verdict === "fail").length;
const warned = results.filter(({ verdict }) => verdict === "warn").length;
console.log(`\n${results.length - failed - warned} passed, ${warned} warned, ${failed} failed`);
process.exitCode = exitCodeFor(results);
