import { lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createInstance,
	createLogBuffer,
	cut,
	debugUrls,
	errorLine,
	escapeRegex,
	formatResult,
	hostHandler,
	linkTree,
	parseArgs,
	parseCdpCalls,
	parseCdpLine,
	parseReplLine,
	parseWait,
	poll,
	quoteCommandLine,
	validName,
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

describe("linkTree", () => {
	it("hard links every file except the skipped folder", async () => {
		const from = join(dir, "install");
		await mkdir(join(from, "resources", "app"), { recursive: true });
		await writeFile(join(from, "TIDAL.exe"), "exe");
		await writeFile(join(from, "resources", "app.asar"), "asar");
		await writeFile(join(from, "resources", "app", "luna.mjs"), "old luna");
		const to = join(dir, "copy");
		await linkTree(from, to, join(from, "resources", "app"));
		expect(await readFile(join(to, "resources", "app.asar"), "utf8")).toBe("asar");
		expect((await stat(join(to, "TIDAL.exe"))).ino).toBe((await stat(join(from, "TIDAL.exe"))).ino);
		await expect(stat(join(to, "resources", "app"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("recreates links to folders instead of copying them", async () => {
		const from = join(dir, "install");
		await mkdir(join(dir, "elsewhere"), { recursive: true });
		await writeFile(join(dir, "elsewhere", "lib.so"), "lib");
		await mkdir(from);
		await symlink(join(dir, "elsewhere"), join(from, "libs"), "junction");
		await linkTree(from, join(dir, "copy"));
		expect((await lstat(join(dir, "copy", "libs"))).isSymbolicLink()).toBe(true);
		expect(await readFile(join(dir, "copy", "libs", "lib.so"), "utf8")).toBe("lib");
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
