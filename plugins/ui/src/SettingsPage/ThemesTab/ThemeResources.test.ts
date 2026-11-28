import { afterEach, describe, expect, test, vi } from "vitest";

import { ThemeResources } from "./ThemeResources";

const response = (status: number, contentType: string | null) =>
	({
		status,
		headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
	}) as Response;

const stubFetch = (fetch: (url: string) => Response | Promise<Response>) =>
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => fetch(String(url))),
	);

afterEach(() => vi.unstubAllGlobals());

describe("ThemeResources.from", () => {
	test("finds the font files a font pack declares", () => {
		// The shape of techroundpack.css: 13 @font-face blocks with a remote url each
		const css = `
			@font-face { font-family: Tech; src: url(https://github.com/o/r/raw/refs/heads/main/fonts/tech/Dream.woff2) format("woff2"); }
			@font-face { font-family: Tech2; src: url("https://github.com/o/r/raw/refs/heads/main/fonts/tech/Mono.ttf") format("truetype"); }
		`;
		const resources = ThemeResources.from(css).resources;
		expect(resources).toHaveLength(2);
		expect(resources.every((resource) => resource.kind === "font")).toBe(true);
		expect(resources[0].absolute).toBe("https://github.com/o/r/raw/refs/heads/main/fonts/tech/Dream.woff2");
	});

	test("separates fonts, images and imported stylesheets", () => {
		const css = `
			@import url(https://cdn.example.com/extra.css);
			.a { background: url(https://cdn.example.com/bg.png); }
			.b { cursor: url(data:image/png;base64,AAAA); }
			@font-face { src: url(../fonts/x.woff2); }
		`;
		const resources = ThemeResources.from(css, "https://themes.example.com/dir/base.css").resources;
		expect(resources.map((resource) => resource.kind)).toEqual(["stylesheet", "image", "other", "font"]);
		expect(resources[0].imported).toBe(true);
		// A relative url is resolved against the theme's own url
		expect(resources[3].absolute).toBe("https://themes.example.com/fonts/x.woff2");
	});

	test("records a data url without treating it as remote", () => {
		const resources = ThemeResources.from(".a{background:url(data:image/png;base64,AA)}", "https://x.test/a.css");
		expect(resources.resources[0].kind).toBe("other");
		expect(resources.remote).toHaveLength(0);
		expect(resources.describe()).toBeUndefined();
	});

	test("finds nothing in plain css", () => {
		expect(ThemeResources.from("body { color: red; }").resources).toEqual([]);
	});

	test("reads the same css once, so a row and a check share the list", () => {
		const css = ".a { background: url(https://img.example.com/a.png); }";
		expect(ThemeResources.from(css, "https://a.test/t.css")).toBe(ThemeResources.from(css, "https://a.test/t.css"));
		// A different base url resolves relative urls differently, so it is a different list
		expect(ThemeResources.from(css, "https://b.test/t.css")).not.toBe(ThemeResources.from(css, "https://a.test/t.css"));
	});

	test("replaces what it read when the stylesheet at that url changes", () => {
		// Keyed by url, not by the css: the old version is dropped rather than kept for the life of the page
		const first = ThemeResources.from(".a{background:url(https://img.example.com/a.png)}", "https://a.test/t.css");
		const second = ThemeResources.from(".b{background:url(https://img.example.com/b.png)}", "https://a.test/t.css");
		expect(second).not.toBe(first);
		expect(second.remote[0].absolute).toBe("https://img.example.com/b.png");
		expect(ThemeResources.from(".b{background:url(https://img.example.com/b.png)}", "https://a.test/t.css")).toBe(second);
	});
});

describe("ThemeResources.describe", () => {
	test("summarises a font pack with its origin", () => {
		const css = Array.from({ length: 13 }, (_, i) => `@font-face { src: url(https://github.com/o/r/raw/main/fonts/f${i}.woff2); }`).join("\n");
		expect(ThemeResources.from(css).describe()).toBe("loads 13 files, 13 fonts, from github.com");
	});

	test("says nothing when a theme loads nothing", () => {
		expect(ThemeResources.from("").describe()).toBeUndefined();
	});

	test("counts an imported stylesheet", () => {
		const resources = ThemeResources.from("@import url(https://cdn.example.com/x.css);", "https://a.test/t.css");
		expect(resources.describe()).toBe("loads 1 file, 1 imported stylesheet, from cdn.example.com");
	});

	test("does not count an image, which the row only needs as part of the total", () => {
		const resources = ThemeResources.from(".a{background:url(https://img.example.com/a.png)}", "https://a.test/t.css");
		expect(resources.describe()).toBe("loads 1 file, from img.example.com");
	});
});

describe("ThemeResources.check", () => {
	const font = (n: number) => `@font-face { src: url(https://github.com/o/r/raw/main/f/f${n}.woff2); }`;
	const fonts = (count: number) => ThemeResources.from(Array.from({ length: count }, (_, i) => font(i)).join("\n"));

	test("checks every file, with no cutoff", async () => {
		// A cap is exploitable: twenty harmless files and then the hostile one never gets looked at
		const seen: string[] = [];
		stubFetch((url) => {
			seen.push(url);
			return response(200, "font/woff2");
		});
		await fonts(60).check();
		expect(seen).toHaveLength(60);
	});

	test("throws for a bad file that sits past the old cutoff", async () => {
		const resources = fonts(40);
		const bad = resources.resources[39].absolute!;
		stubFetch((url) => response(200, url === bad ? "text/html" : "font/woff2"));
		await expect(resources.check()).rejects.toThrow("f39.woff2 is not a font (text/html)");
	});

	test("checks every file before reporting a failure, so the row's progress finishes first", async () => {
		// Reporting as soon as one file fails left the rest in flight, and they wrote progress after the caller had cleared it
		const seen: number[] = [];
		const resources = ThemeResources.from(Array.from({ length: 4 }, (_, i) => `@font-face { src: url(https://a.test/f${i}.woff2); }`).join("\n"));
		stubFetch((url) => response(200, url.includes("f1") ? "text/html" : "font/woff2"));
		await expect(resources.check((done) => seen.push(done))).rejects.toThrow("is not a font");
		expect(seen).toEqual([1, 2, 3, 4]);
	});

	test("checks a repeated url once, since it is one download", async () => {
		const css = Array.from({ length: 4 }, () => "@font-face { src: url(https://github.com/o/r/raw/main/f/Bold.ttf); }").join("\n");
		let calls = 0;
		stubFetch(() => {
			calls++;
			return response(200, "font/ttf");
		});
		await ThemeResources.from(css).check();
		expect(calls).toBe(1);
	});

	test("reports progress as each file finishes, and never more than the requests at once", async () => {
		const progress: number[] = [];
		let inFlight = 0;
		let peak = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise((r) => setTimeout(r, 5));
				inFlight--;
				return response(200, "font/woff2");
			}),
		);
		await fonts(5).check((done, total) => {
			expect(total).toBe(5);
			progress.push(done);
		});
		// Every file reported exactly once, in order
		expect(progress).toEqual([1, 2, 3, 4, 5]);
		// And never more than the configured number at a time
		expect(peak).toBeLessThanOrEqual(6);
	});

	test("reports a request that never got a response, with the file it was for", async () => {
		stubFetch(() => {
			throw new Error("network down");
		});
		await expect(fonts(3).check()).rejects.toThrow("could not be checked");
	});

	test("throws on a 404, a font that is not a font, and a non-stylesheet import", async () => {
		const resources = ThemeResources.from(`
			@font-face { src: url(https://a.test/missing.woff2); }
			.a { background: url(https://a.test/pic.png); }
			@import url(https://a.test/extra.css);
		`);
		stubFetch((url) => {
			if (url.includes("missing")) return response(404, "text/plain");
			if (url.includes("pic")) return response(200, "text/css");
			return response(200, "text/html");
		});
		// Files are checked several at a time, so which of the three is reported first is not fixed
		await expect(resources.check()).rejects.toThrow(/answered HTTP 404|is not an image|is not a stylesheet/);
	});

	test("says nothing was answered for a response with no status", async () => {
		stubFetch(() => response(0, null));
		await expect(fonts(1).check()).rejects.toThrow("answered nothing");
	});

	test("reports a missing content type rather than passing it", async () => {
		stubFetch(() => response(200, null));
		await expect(fonts(1).check()).rejects.toThrow("is not a font (no content type)");
	});

	test("does nothing, cleanly, for a theme that loads no files", async () => {
		stubFetch(() => response(200, "font/woff2"));
		await expect(ThemeResources.from("body{}").check()).resolves.toBeUndefined();
	});

	test("accepts a remote image and an imported stylesheet that are what they claim", async () => {
		const resources = ThemeResources.from(`
			.a { background: url(https://a.test/pic.png); }
			@import url(https://a.test/extra.css);
		`);
		stubFetch((url) => response(200, url.includes("pic") ? "image/png" : "text/css"));
		await expect(resources.check()).resolves.toBeUndefined();
	});

	test("accepts a font from a host that sends it as a generic binary", async () => {
		stubFetch(() => response(200, "application/octet-stream"));
		await expect(fonts(1).check()).resolves.toBeUndefined();
	});
});
