import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveAbsolutePath } from "./resolvePath";

describe("resolveAbsolutePath", () => {
	beforeEach(() => {
		// The empty input branches report themselves through console.warn
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("resolves a relative path against the directory of the base file", () => {
		expect(resolveAbsolutePath("/dir/page.js", "a.js")).toBe("/dir/a.js");
		expect(resolveAbsolutePath("/dir/page.js", "./a.js")).toBe("/dir/a.js");
		expect(resolveAbsolutePath("/dir/page.js", "./sub/a.js")).toBe("/dir/sub/a.js");
		expect(resolveAbsolutePath("/dir/page.js", "./sub/")).toBe("/dir/sub/");
		// A base path that already names a directory keeps it
		expect(resolveAbsolutePath("/dir/", "a.js")).toBe("/dir/a.js");
	});

	test("walks up with .. and clamps at the root", () => {
		expect(resolveAbsolutePath("/dir/page.js", "../a.js")).toBe("/a.js");
		expect(resolveAbsolutePath("/dir/sub/page.js", "../a.js")).toBe("/dir/a.js");
		expect(resolveAbsolutePath("/a/b/c/page.js", "../../../x.js")).toBe("/x.js");
		// More .. than there are directories stays at the root
		expect(resolveAbsolutePath("/a/b/c/page.js", "../../../../x.js")).toBe("/x.js");
		expect(resolveAbsolutePath("/dir/page.js", "../../../x.js")).toBe("/x.js");
	});

	test("returns an already absolute path unchanged", () => {
		expect(resolveAbsolutePath("/dir/page.js", "/x.js")).toBe("/x.js");
		expect(resolveAbsolutePath("/a/b/c/page.js", "/x/y.js")).toBe("/x/y.js");
	});

	test("treats a base path without a leading slash as rooted at /", () => {
		expect(resolveAbsolutePath("dir/page.js", "a.js")).toBe("/dir/a.js");
		expect(resolveAbsolutePath("page.js", "a.js")).toBe("/a.js");
	});

	/**
	 * The result is a URL pathname, so a query string or fragment on the requested path is dropped.
	 * TIDAL module paths never carry one, but it is worth pinning: callers only get the path back.
	 */
	test("drops query strings and fragments, returning only the pathname", () => {
		expect(resolveAbsolutePath("/dir/page.js", "a.js?v=1")).toBe("/dir/a.js");
		expect(resolveAbsolutePath("/dir/page.js", "a.js#hash")).toBe("/dir/a.js");
		expect(resolveAbsolutePath("/dir/page.js", "/x.js?v=1")).toBe("/x.js");
	});

	test("empty inputs are handed back unchanged and reported", () => {
		// No base to resolve against: the requested path is returned as-is
		expect(resolveAbsolutePath("", "a.js")).toBe("a.js");
		// No path to resolve: the base is returned as-is
		expect(resolveAbsolutePath("/dir/page.js", "")).toBe("/dir/page.js");
		expect(resolveAbsolutePath("", "")).toBe("");

		expect(console.warn).toHaveBeenCalledTimes(3);
		expect(console.warn).toHaveBeenCalledWith("[Luna.resolveAbsolutePath] Invalid input:", { basePath: "", relativePath: "a.js" });
		expect(console.warn).toHaveBeenCalledWith("[Luna.resolveAbsolutePath] Invalid input:", { basePath: "/dir/page.js", relativePath: "" });
	});

	test("a base path directly in the root cannot be resolved against, so the relative path is returned", () => {
		expect(resolveAbsolutePath("/", "a.js")).toBe("a.js");
		expect(resolveAbsolutePath("/page.js", "a.js")).toBe("a.js");

		expect(console.warn).toHaveBeenCalledTimes(2);
		expect(console.warn).toHaveBeenCalledWith("[Luna.resolveAbsolutePath] Invalid baseDirectory:", "/");
	});
});
