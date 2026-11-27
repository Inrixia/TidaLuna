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
	 * A query string or fragment can name the resource (a versioned plugin url, a hashed module), so resolving has to
	 * keep it: dropping it would hand back the path of a different resource.
	 */
	test("keeps query strings and fragments", () => {
		expect(resolveAbsolutePath("/dir/page.js", "a.js?v=1")).toBe("/dir/a.js?v=1");
		expect(resolveAbsolutePath("/dir/page.js", "a.js#hash")).toBe("/dir/a.js#hash");
		expect(resolveAbsolutePath("/dir/page.js", "/x.js?v=1")).toBe("/x.js?v=1");
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
	 * A base that is not a '/' path (a Windows path, say) makes `new URL` throw, since `C:` parses as a URL scheme and the
	 * base is then opaque. The fallback joins by hand. The callers pass TIDAL module paths, so it is a safety net: what is
	 * pinned is that it answers and says so, not the joined text.
	 */
	test("answers through the fallback, and reports it, when the URL constructor throws", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		// String.raw: in a plain string literal `\d` and `\p` are not escapes and the backslashes would be gone
		const windowsBase = String.raw`C:\dir\page.js`;
		expect(windowsBase).toContain("\\");

		expect(typeof resolveAbsolutePath(windowsBase, "a.js")).toBe("string");
		expect(typeof resolveAbsolutePath(windowsBase, "./a.js")).toBe("string");
		expect(console.error).toHaveBeenCalledTimes(2);
		expect(console.error).toHaveBeenCalledWith(
			"[Luna.resolveAbsolutePath] Failed to resolve path:",
			expect.objectContaining({ basePath: windowsBase, relativePath: "a.js", error: expect.any(String) }),
		);
	});

	// `new URL` throws on the base first, then the fallback's `startsWith("/")` arm returns the path: it doesn't skip the base
	test("an absolute path with a base that throws is returned by the fallback", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect(resolveAbsolutePath(String.raw`C:\dir\page.js`, "/x.js")).toBe("/x.js");
		expect(console.error).toHaveBeenCalledTimes(1);
	});

	/**
	 * The result is a URL path, not a file system path. These are pinned as they behave today so a change is deliberate:
	 * a full URL or a `//host` path loses its host, and percent-encoding follows the URL rules.
	 */
	test("a full url or a path with a host loses the host, and the result is url-encoded", () => {
		expect(resolveAbsolutePath("/dir/page.js", "https://other.example/x.js")).toBe("/x.js");
		expect(resolveAbsolutePath("/dir/page.js", "//host/x.js")).toBe("/x.js");
		expect(resolveAbsolutePath("/dir/page.js", "a b.js")).toBe("/dir/a%20b.js");
		expect(resolveAbsolutePath("/dir/page.js", "a%2Fb.js")).toBe("/dir/a%2Fb.js");
	});
});
