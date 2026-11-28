import { lstat, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile, mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	copyTree,
	createInstance,
	createLogBuffer,
	cut,
	debugUrls,
	errorLine,
	escapeRegex,
	formatResult,
	hostHandler,
	parseArgs,
	parseCdpCalls,
	parseCdpLine,
	parseReplLine,
	parseWait,
	poll,
	lockHeld,
	pidAlive,
	quoteCommandLine,
	removeHostFile,
	removeTree,
	requestStop,
	stopRequested,
	sleep,
	unlockOwn,
	validName,
	withLock,
	writeFiles,
} from "./lib.mjs";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "tidal-test-lib-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("parseArgs", () => {
	it("takes --instance, --since and --native from anywhere", () => {
		const parsed = parseArgs(["eval", "--native", "1+1", "--instance", "ab12cd", "--since", "4"]);
		expect(parsed).toMatchObject({ valid: true, instance: "ab12cd", since: "4", native: true, command: "eval", arg: "1+1" });
	});
	it("rejects a flag without its value", () => {
		expect(parseArgs(["start", "--instance"]).valid).toBe(false);
		expect(parseArgs(["eval", "1", "--instance", "--native"]).valid).toBe(false);
		expect(parseArgs(["logs", "--instance", "a", "--since"]).valid).toBe(false);
	});
	it("needs no --instance for start, list and setup", () => {
		for (const command of ["start", "list", "setup"]) expect(parseArgs([command]).valid).toBe(true);
	});
	it("rejects instance names that could leave .tidal-test or break a command line", () => {
		for (const name of ["..", "../x", "a/b", 'a"b', "a b", "", "x".repeat(33)]) expect(parseArgs(["stop", "--instance", name]).valid).toBe(false);
		expect(validName("my-instance_1")).toBe(true);
	});
	it("rejects unknown commands and missing arguments", () => {
		expect(parseArgs(["nope"]).valid).toBe(false);
		expect(parseArgs([]).valid).toBe(false);
		for (const command of ["eval", "native", "wait", "screenshot", "cdp"]) expect(parseArgs([command, "--instance", "a"]).valid).toBe(false);
	});
	it("rejects negative or non-numeric seconds", () => {
		expect(parseArgs(["logs", "-1", "--instance", "a"]).valid).toBe(false);
		expect(parseArgs(["logs", "5", "--instance", "a"]).valid).toBe(true);
		expect(parseArgs(["wait", "x", "soon", "--instance", "a"]).valid).toBe(false);
		expect(parseArgs(["logs", "--since", "x", "--instance", "a"]).valid).toBe(false);
	});
	it("takes --no-login for start only", () => {
		expect(parseArgs(["start", "--no-login"])).toMatchObject({ valid: true, noLogin: true, command: "start" });
		expect(parseArgs(["--no-login", "start", "--instance", "a"])).toMatchObject({ valid: true, noLogin: true, instance: "a" });
		expect(parseArgs(["start"]).noLogin).toBe(false);
		expect(parseArgs(["stop", "--instance", "a", "--no-login"]).valid).toBe(false);
	});
	it("only takes --all and --no-login next to the command", () => {
		expect(parseArgs(["logs", "--all"]).valid).toBe(false);
		expect(parseArgs(["--all", "stop"])).toMatchObject({ valid: true, all: true });
		// Further on it's an argument of the command, not a switch
		expect(parseArgs(["wait", "x", "5", "--all"])).toMatchObject({ valid: true, all: false });
	});
	it("takes remove with a name, and stop --all without one", () => {
		expect(parseArgs(["remove", "--instance", "a"])).toMatchObject({ valid: true, command: "remove", instance: "a" });
		expect(parseArgs(["stop", "--all"])).toMatchObject({ valid: true, all: true, command: "stop" });
		expect(parseArgs(["stop", "--instance", "a"]).all).toBe(false);
		expect(parseArgs(["stop", "--all", "--instance", "a"]).valid).toBe(false);
		expect(parseArgs(["list", "--all"]).valid).toBe(false);
	});
	it("leaves --all and --no-login in free-form arguments", () => {
		expect(parseArgs(["eval", "--all", "--instance", "a"])).toMatchObject({ valid: true, arg: "--all", all: false });
		expect(parseArgs(["cdp", "--no-login", "--instance", "a"])).toMatchObject({ valid: true, arg: "--no-login", noLogin: false });
	});
	it("keeps cdp's method/params list in args", () => {
		expect(parseArgs(["--instance", "a", "cdp", "A.b", "{}", "C.d"]).args).toEqual(["cdp", "A.b", "{}", "C.d"]);
	});
});

describe("createInstance", () => {
	it("creates parallel random instances without collisions", async () => {
		const names = await Promise.all(Array.from({ length: 20 }, () => createInstance(join(dir, ".tidal-test"))));
		expect(new Set(names).size).toBe(20);
		for (const name of names) expect(name).toMatch(/^[0-9a-f]{6}$/);
		expect((await readdir(join(dir, ".tidal-test"))).sort()).toEqual([...names].sort());
	});
	it("creates a given name, and refuses one that exists", async () => {
		expect(await createInstance(dir, "mine")).toBe("mine");
		await expect(createInstance(dir, "mine")).rejects.toMatchObject({ code: "EEXIST" });
	});
});

describe("copyTree", () => {
	it("copies every file except the skipped folder, without linking them", async () => {
		const from = join(dir, "install");
		await mkdir(join(from, "resources", "app"), { recursive: true });
		await writeFile(join(from, "TIDAL.exe"), "exe");
		await writeFile(join(from, "resources", "app.asar"), "asar");
		await writeFile(join(from, "resources", "app", "luna.mjs"), "old luna");
		const to = join(dir, "copy");
		await copyTree(from, to, join(from, "resources", "app"));
		expect(await readFile(join(to, "resources", "app.asar"), "utf8")).toBe("asar");
		expect(await readFile(join(to, "TIDAL.exe"), "utf8")).toBe("exe");
		// A hard link would be one file with two names
		expect((await stat(join(from, "TIDAL.exe"))).nlink).toBe(1);
		await writeFile(join(to, "TIDAL.exe"), "changed");
		expect(await readFile(join(from, "TIDAL.exe"), "utf8")).toBe("exe");
		await expect(stat(join(to, "resources", "app"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("copies a dangling link as a link", async () => {
		const from = join(dir, "install");
		await mkdir(from);
		await symlink(join(dir, "nowhere"), join(from, "dangling"), "file");
		await copyTree(from, join(dir, "copy"));
		expect((await lstat(join(dir, "copy", "dangling"))).isSymbolicLink()).toBe(true);
	});
	it("recreates links to folders instead of copying them", async () => {
		const from = join(dir, "install");
		await mkdir(join(dir, "elsewhere"), { recursive: true });
		await writeFile(join(dir, "elsewhere", "lib.so"), "lib");
		await mkdir(from);
		await symlink(join(dir, "elsewhere"), join(from, "libs"), "junction");
		await copyTree(from, join(dir, "copy"));
		expect((await lstat(join(dir, "copy", "libs"))).isSymbolicLink()).toBe(true);
		expect(await readFile(join(dir, "copy", "libs", "lib.so"), "utf8")).toBe("lib");
	});
});

describe("withLock", () => {
	it("runs one at a time, and releases the lock when done or failed", async () => {
		const lock = join(dir, "start.lock");
		const order: string[] = [];
		const run = (name: string) =>
			withLock(lock, async () => {
				order.push(`${name} in`);
				await sleep(100);
				order.push(`${name} out`);
			});
		await Promise.all([run("a"), run("b")]);
		expect(order).toEqual(["a in", "a out", "b in", "b out"]);
		await expect(withLock(lock, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
		// A waiter may meet the lock before its pid is written and then waits out the grace period
	}, 15_000);
	it("takes over a lock whose holder is gone, but waits for a live one", async () => {
		const lock = join(dir, "start.lock");
		await writeFile(lock, "999999");
		expect(await withLock(lock, async () => "ran", { alive: () => false })).toBe("ran");
		await writeFile(lock, "999999");
		await expect(withLock(lock, async () => "ran", { alive: () => true, seconds: 0.5 })).rejects.toThrow("still running");
		// Not ours to delete while its holder lives
		expect(await readFile(lock, "utf8")).toBe("999999");
	});
	it("takes over a lock older than staleSeconds even if its pid lives (pid reuse)", async () => {
		const lock = join(dir, "start.lock");
		await writeFile(lock, "999999");
		const old = new Date(Date.now() - 600_000);
		await utimes(lock, old, old);
		expect(await withLock(lock, async () => "ran", { alive: () => true })).toBe("ran");
	});
	it("lets only one of many waiters take over a stale lock", async () => {
		const lock = join(dir, "start.lock");
		await writeFile(lock, "999999");
		let inside = 0;
		let overlap = false;
		await Promise.all(
			Array.from({ length: 6 }, () =>
				withLock(
					lock,
					async () => {
						overlap ||= ++inside > 1;
						await sleep(30);
						inside--;
					},
					{ alive: (pid) => pid !== 999999 },
				),
			),
		);
		expect(overlap).toBe(false);
	});
	it("says so when the lock's folder doesn't exist", async () => {
		await expect(withLock(join(dir, "gone", "start.lock"), async () => "ran")).rejects.toThrow("doesn't exist");
	});
	it("keeps its lock fresh while it runs, so a live holder isn't taken over by age", async () => {
		const lock = join(dir, "start.lock");
		let inside = 0;
		let overlap = false;
		const run = () =>
			withLock(
				lock,
				async () => {
					overlap ||= ++inside > 1;
					await sleep(2500);
					inside--;
				},
				{ staleSeconds: 1.5, seconds: 10 },
			);
		await Promise.all([run(), (async () => (await sleep(300), run()))()]);
		expect(overlap).toBe(false);
	});
	it("lockHeld: a live, recent lock only", async () => {
		const lock = join(dir, "start.lock");
		expect(await lockHeld(lock)).toBe(false);
		await writeFile(lock, "4242");
		expect(await lockHeld(lock, { alive: () => true })).toBe(true);
		expect(await lockHeld(lock, { alive: () => false })).toBe(false);
		// Just created, pid not written yet
		await writeFile(lock, "");
		expect(await lockHeld(lock)).toBe(true);
		const old = new Date(Date.now() - 600_000);
		await utimes(lock, old, old);
		expect(await lockHeld(lock, { alive: () => true })).toBe(false);
		// Not a plain pid: withLock takes such a lock over, so it isn't held
		await writeFile(lock, "1e3");
		expect(await lockHeld(lock, { alive: () => true })).toBe(false);
	});
	it("unlockOwn deletes only a lock holding our pid", async () => {
		const lock = join(dir, "start.lock");
		await writeFile(lock, "999999");
		await unlockOwn(lock);
		expect(await readFile(lock, "utf8")).toBe("999999");
		await writeFile(lock, String(process.pid));
		await unlockOwn(lock);
		await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("treats a lock without a pid as stale", async () => {
		const lock = join(dir, "start.lock");
		// Number() would read the last one as this live process
		for (const content of ["", "garbage", `${process.pid}e0`]) {
			await writeFile(lock, content);
			expect(await withLock(lock, async () => "ran")).toBe("ran");
		}
	});
	it("knows this process is alive, and a dead pid isn't", () => {
		expect(pidAlive(process.pid)).toBe(true);
		expect(pidAlive(2 ** 22 + 12345)).toBe(false);
		expect(pidAlive(0)).toBe(false);
		expect(pidAlive(NaN)).toBe(false);
	});
});

describe("removeTree", () => {
	it("deletes the tree but never enters a link in it, and the link's target survives", async () => {
		await mkdir(join(dir, "dist"));
		await writeFile(join(dir, "dist", "luna.mjs"), "luna");
		await mkdir(join(dir, "other"));
		await writeFile(join(dir, "other", "keep.txt"), "keep");
		await mkdir(join(dir, "app", "resources", "deep"), { recursive: true });
		await writeFile(join(dir, "app", "resources", "deep", "f.txt"), "f");
		await symlink(join(dir, "dist"), join(dir, "app", "resources", "app"), "junction");
		await symlink(join(dir, "other"), join(dir, "app", "elsewhere"), "junction");
		await removeTree(join(dir, "app"));
		await expect(lstat(join(dir, "app"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(dir, "dist", "luna.mjs"), "utf8")).toBe("luna");
		expect(await readFile(join(dir, "other", "keep.txt"), "utf8")).toBe("keep");
	});
	it("ignores a path that doesn't exist, and deletes a single file", async () => {
		await removeTree(join(dir, "missing"));
		await writeFile(join(dir, "f"), "x");
		await removeTree(join(dir, "f"));
		expect(await readdir(dir)).toEqual([]);
	});
});

describe("stop request", () => {
	it("only counts a request made after the start began", async () => {
		const file = join(dir, "stop.request");
		expect(await stopRequested(file, 0)).toBe(false);
		await requestStop(file);
		expect(await stopRequested(file, Date.now() - 5000)).toBe(true);
		expect(await stopRequested(file, Date.now() + 5000)).toBe(false);
	});
});

describe("removeHostFile", () => {
	it("removes the host.json of its own token only", async () => {
		const file = join(dir, "host.json");
		await writeFile(file, JSON.stringify({ port: 1, token: "first" }));
		removeHostFile(file, "second");
		expect(JSON.parse(await readFile(file, "utf8")).token).toBe("first");
		removeHostFile(file, "first");
		await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("ignores a missing or unreadable host.json", async () => {
		const file = join(dir, "host.json");
		expect(() => removeHostFile(file, "x")).not.toThrow();
		await writeFile(file, "{half");
		expect(() => removeHostFile(file, "x")).not.toThrow();
		expect(await readFile(file, "utf8")).toBe("{half");
	});
});

describe("writeFiles", () => {
	it("writes nested paths, leading slashes relative to dir", async () => {
		expect(await writeFiles(dir, { "a/b.js": "b", "/c.js": "c" })).toBe(2);
		expect(await readFile(join(dir, "a", "b.js"), "utf8")).toBe("b");
		expect(await readFile(join(dir, "c.js"), "utf8")).toBe("c");
	});
	it("never writes outside dir", async () => {
		const inner = join(dir, "inner");
		await mkdir(inner);
		await writeFiles(inner, { "../escape.js": "x", "a/../../escape2.js": "x", [resolve(dir, "abs.js")]: "x" });
		expect(await readdir(dir)).toEqual(["inner"]);
	});
	it("returns what it wrote, not what it was given", async () => {
		// The count is printed as the result of a dump, so it has to describe the disk: refusing every path must not report 3
		expect(await writeFiles(dir, { "kept.js": "k", "../escape.js": "x", "/../escape2.js": "x" })).toBe(1);
		expect(await readdir(dir)).toEqual(["kept.js"]);
	});
	it("writes when the caller passes dir with a trailing separator", async () => {
		// Comparing a resolved path against an unresolved dir rejected every write here, and said nothing while doing it
		expect(await writeFiles(`${dir}${sep}`, { "a.js": "a" })).toBe(1);
		expect(await readFile(join(dir, "a.js"), "utf8")).toBe("a");
	});
});

describe("output", () => {
	it("cuts long text and says how long it was", () => {
		expect(cut("short")).toBe("short");
		const long = cut("x".repeat(25000));
		expect(long.startsWith("x".repeat(20000))).toBe(true);
		expect(long).toContain("(cut, 25000 chars, return less)");
	});
	it("formats results as compact JSON, else their description", () => {
		expect(formatResult({ type: "object", value: { a: [1, 2] } })).toBe('{"a":[1,2]}');
		expect(formatResult({ type: "object", subtype: "node", description: "div#app" })).toBe("div#app");
		expect(formatResult({ type: "undefined" })).toBe("undefined");
	});
	it("shows errors as their first line, with an error name", () => {
		expect(errorLine(new Error("TypeError: x is not a function\n    at <anonymous>"))).toBe("TypeError: x is not a function");
		expect(errorLine(new Error("boom"))).toBe("Error: boom");
	});
});

describe("repl lines", () => {
	it("tells commands from expressions", () => {
		expect(parseReplLine(":native process.pid")).toEqual({ name: "native", rest: "process.pid" });
		expect(parseReplLine(":reload")).toEqual({ name: "reload", rest: "" });
		expect(parseReplLine("a ? b : c")).toEqual({ name: undefined, rest: "" });
		expect(parseReplLine("({ a: 1 })").name).toBeUndefined();
	});
	it(":wait takes optional seconds first", () => {
		expect(parseWait("5 document.readyState === 'complete'")).toEqual({ seconds: 5, expression: "document.readyState === 'complete'" });
		expect(parseWait("ready()")).toEqual({ seconds: 30, expression: "ready()" });
		// A number as the expression alone isn't taken for seconds
		expect(parseWait("42")).toEqual({ seconds: 30, expression: "42" });
	});
	it(":cdp takes a method and optional JSON params", () => {
		expect(parseCdpLine('Runtime.evaluate {"expression":"1+1"}')).toEqual({ method: "Runtime.evaluate", params: { expression: "1+1" } });
		expect(parseCdpLine("Performance.enable")).toEqual({ method: "Performance.enable", params: undefined });
		expect(() => parseCdpLine("A.b {nope")).toThrow();
	});
	it("cdp arguments pair methods with following JSON", () => {
		expect(parseCdpCalls(["A.enable", "B.call", ' {"x":1}', "C.call"])).toEqual([
			{ method: "A.enable", params: undefined },
			{ method: "B.call", params: { x: 1 } },
			{ method: "C.call", params: undefined },
		]);
	});
});

describe("process plumbing", () => {
	it("finds both debugging urls in TIDAL's output", () => {
		const output =
			"Debugger listening on ws://127.0.0.1:51234/0b1c-uuid\nFor help, see: https://nodejs.org/en/docs/inspector\n\nDevTools listening on ws://127.0.0.1:51240/devtools/browser/abc\n";
		expect(debugUrls(output)).toEqual({ inspector: "ws://127.0.0.1:51234/0b1c-uuid", devtools: "ws://127.0.0.1:51240/devtools/browser/abc" });
		expect(debugUrls("Debugger listening on ws://127.0.0.1:1/x\n").devtools).toBeUndefined();
		// Output split mid-url: not taken until the line ends
		expect(debugUrls("DevTools listening on ws://127.0.0.1:512").devtools).toBeUndefined();
	});
	it("quotes Windows command lines and refuses quotes", () => {
		expect(quoteCommandLine(["C:\\Program Files\\node.exe", "a b", "x"])).toBe('"C:\\Program Files\\node.exe" "a b" "x"');
		expect(() => quoteCommandLine(['a" & calc "'])).toThrow();
	});
	it("escapes regex characters for pkill", () => {
		const arg = "--user-data-dir=/home/u/repo (1)/.tidal-test/a+b/profile";
		expect(new RegExp(escapeRegex(arg)).test(`tidal-hifi ${arg} --x`)).toBe(true);
		expect(new RegExp(escapeRegex("a.b")).test("axb")).toBe(false);
	});
	it("poll returns the first defined result, ignoring errors, and times out", async () => {
		let calls = 0;
		expect(await poll(async () => (++calls === 1 ? Promise.reject(new Error("not yet")) : calls === 3 ? "done" : undefined), 5, "late")).toBe(
			"done",
		);
		await expect(poll(async () => undefined, 0.3, "too late")).rejects.toThrow("too late");
	});
});

describe("host API", () => {
	let server: Server;
	let base: string;
	const logs = createLogBuffer(3);
	const state = { tidalPid: 1, devtools: "ws://a", inspector: "ws://b" };
	beforeEach(async () => {
		server = createServer(hostHandler({ token: "secret", state, logs }));
		await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterEach(() => new Promise<void>((res) => server.close(() => res())));

	it("rejects requests without the token", async () => {
		expect((await fetch(`${base}/state`)).status).toBe(403);
		expect((await fetch(`${base}/state?token=wrong`)).status).toBe(403);
	});
	it("serves state", async () => {
		expect(await (await fetch(`${base}/state?token=secret`)).json()).toEqual(state);
		expect((await fetch(`${base}/nope?token=secret`)).status).toBe(404);
	});
	it("serves logs after a cursor, dropping the oldest past the limit", async () => {
		for (const line of ["a", "b", "c", "d"]) logs.add(line);
		expect(await (await fetch(`${base}/logs?token=secret`)).json()).toEqual({ lines: ["b", "c", "d"], next: 4 });
		expect(await (await fetch(`${base}/logs?token=secret&since=3`)).json()).toEqual({ lines: ["d"], next: 4 });
		expect(await (await fetch(`${base}/logs?token=secret&since=4`)).json()).toEqual({ lines: [], next: 4 });
	});
});
