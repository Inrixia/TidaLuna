import { isBuiltin } from "module";

import { describe, expect, test } from "vitest";

import { moduleWhitelist } from "./moduleWhitelist";

/** Modules that can reach outside the vm sandbox: each one must be asked for, never handed out */
const privilegedModules = [
	"fs",
	"fs/promises",
	"original-fs",
	"net",
	"http",
	"https",
	"http2",
	"tls",
	"dns",
	"dgram",
	"os",
	"child_process",
	"worker_threads",
	"cluster",
	"electron",
	"vm",
	"inspector",
	"v8",
	"module",
	"repl",
	"process",
	"wasi",
];

describe("moduleWhitelist", () => {
	test.each(privilegedModules)("%s is not handed out without a permission prompt", (moduleName) => {
		expect(moduleWhitelist.has(moduleName)).toBe(false);
	});

	test.each(["path", "path/posix", "crypto", "util", "util/types", "stream/web", "zlib", "url"])("%s is free to use", (moduleName) => {
		expect(moduleWhitelist.has(moduleName)).toBe(true);
	});

	test("entries are written the way nativeRequire looks them up", () => {
		// secureLoad strips `node:` and `/promises` before the lookup, so an entry written with either never matches
		for (const entry of moduleWhitelist) {
			expect(entry.startsWith("node:")).toBe(false);
			expect(entry).not.toMatch(/\/promises$/);
			expect(entry).toBe(entry.trim());
		}
	});

	test("every entry is a real Node builtin, not a typo", () => {
		for (const entry of moduleWhitelist) expect(isBuiltin(entry), entry).toBe(true);
	});
});
