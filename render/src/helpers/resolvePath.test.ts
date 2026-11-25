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

	test("resolves against a base path directly in the root", () => {
		expect(resolveAbsolutePath("/a.js", "./b.js")).toBe("/b.js");
		expect(resolveAbsolutePath("/a.js", "b.js")).toBe("/b.js");
		expect(resolveAbsolutePath("/a.js", "./sub/b.js")).toBe("/sub/b.js");
		expect(resolveAbsolutePath("/a.js", "/x.js")).toBe("/x.js");
		// A base path that is the root directory itself
		expect(resolveAbsolutePath("/", "b.js")).toBe("/b.js");
		// .. from the root stays at the root
		expect(resolveAbsolutePath("/a.js", "../b.js")).toBe("/b.js");
		expect(resolveAbsolutePath("/a.js", "../../b.js")).toBe("/b.js");

		expect(console.warn).not.toHaveBeenCalled();
	});

	test("nested modules still resolve against their own directory", () => {
		expect(resolveAbsolutePath("/dir/a.js", "./b.js")).toBe("/dir/b.js");
		expect(resolveAbsolutePath("/dir/a.js", "../b.js")).toBe("/b.js");
		expect(resolveAbsolutePath("/dir/sub/a.js", "../b.js")).toBe("/dir/b.js");
	});

	/**
	 * A base that is not a '/' path (a Windows path, say) makes `new URL` throw, and the fallback joins by hand. The callers
	 * pass TIDAL's module paths, so it is a safety net: what is pinned is that it answers instead of throwing, and says so.
	 * The joined text itself (it keeps the base's file name) is not pinned.
	 */
	test("answers through the fallback, and reports it, when the URL constructor throws", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect(resolveAbsolutePath("C:\dir\page.js", "a.js")).toContain("a.js");
		expect(resolveAbsolutePath("C:\dir\page.js", "./a.js")).not.toContain("./");
		expect(console.error).toHaveBeenCalledTimes(2);
		expect(console.error).toHaveBeenCalledWith(
			"[Luna.resolveAbsolutePath] Failed to resolve path:",
			expect.objectContaining({ basePath: "C:\dir\page.js", relativePath: "a.js", error: expect.any(String) }),
		);

		// An absolute path needs no base
		expect(resolveAbsolutePath("C:\dir\page.js", "/x.js")).toBe("/x.js");
	});
});
