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

describe("ThemeResources.assertStylesheet", () => {
	test("accepts a real stylesheet", () => {
		expect(() => ThemeResources.assertStylesheet("body { color: red; }", "text/plain; charset=utf-8")).not.toThrow();
		expect(() => ThemeResources.assertStylesheet(":root { --a: 1; }")).not.toThrow();
		expect(() => ThemeResources.assertStylesheet("@import 'x.css';")).not.toThrow();
	});

	test("refuses the html page github serves instead of a missing file", () => {
		// This is what a raw url for a missing file, and every /blob/ page, answers with
		expect(() => ThemeResources.assertStylesheet("<!DOCTYPE html>\n<html lang=en>...", "text/html")).toThrow(
			"That url returned a web page, not a stylesheet",
		);
		expect(() => ThemeResources.assertStylesheet("  \n<html><body>404</body></html>")).toThrow("That url returned a web page, not a stylesheet");
	});

	test("refuses json, an error body, an empty body and words", () => {
		expect(() => ThemeResources.assertStylesheet('{"message":"Not Found"}', "application/json")).toThrow(
			"That url returned json, not a stylesheet",
		);
		expect(() => ThemeResources.assertStylesheet("[1,2,3]")).toThrow("That url returned json, not a stylesheet");
		expect(() => ThemeResources.assertStylesheet("404: Not Found")).toThrow("That url returned an error, not a stylesheet");
		expect(() => ThemeResources.assertStylesheet("Not Found")).toThrow("That url returned an error, not a stylesheet");
		expect(() => ThemeResources.assertStylesheet("   \n  ")).toThrow("That url returned an empty body");
		expect(() => ThemeResources.assertStylesheet("just some words")).toThrow("That url does not look like css");
	});
});

describe("ThemeResources.of", () => {
	test("finds the font files a font pack declares", () => {
		// The shape of techroundpack.css: 13 @font-face blocks with a remote url each
		const css = `
			@font-face { font-family: Tech; src: url(https://github.com/o/r/raw/refs/heads/main/fonts/tech/Dream.woff2) format("woff2"); }
			@font-face { font-family: Tech2; src: url("https://github.com/o/r/raw/refs/heads/main/fonts/tech/Mono.ttf") format("truetype"); }
		`;
		const resources = ThemeResources.of(css).resources;
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
		const resources = ThemeResources.of(css, "https://themes.example.com/dir/base.css").resources;
		expect(resources.map((resource) => resource.kind)).toEqual(["stylesheet", "image", "other", "font"]);
		expect(resources[0].imported).toBe(true);
		// A relative url is resolved against the theme's own url
		expect(resources[3].absolute).toBe("https://themes.example.com/fonts/x.woff2");
	});

	test("records a data url without treating it as remote", () => {
		const resources = ThemeResources.of(".a{background:url(data:image/png;base64,AA)}", "https://x.test/a.css");
		expect(resources.resources[0].kind).toBe("other");
		expect(resources.remote).toHaveLength(0);
		expect(resources.describe()).toBeUndefined();
	});

	test("finds nothing in plain css", () => {
		expect(ThemeResources.of("body { color: red; }").resources).toEqual([]);
	});
});

describe("ThemeResources content types", () => {
	test("accepts the types hosts actually send fonts with", () => {
		expect(ThemeResources.isFontContentType("font/woff2")).toBe(true);
		expect(ThemeResources.isFontContentType("application/font-woff")).toBe(true);
		expect(ThemeResources.isFontContentType("application/octet-stream")).toBe(true);
		expect(ThemeResources.isFontContentType("font/ttf; charset=binary")).toBe(true);
		expect(ThemeResources.isFontContentType("application/vnd.ms-fontobject")).toBe(true);
		expect(ThemeResources.isFontContentType("application/x-font-ttf")).toBe(true);
		expect(ThemeResources.isFontContentType("application/x-font-opentype")).toBe(true);
	});

	test("rejects what is not a font", () => {
		expect(ThemeResources.isFontContentType("text/html")).toBe(false);
		expect(ThemeResources.isFontContentType("text/css")).toBe(false);
		expect(ThemeResources.isFontContentType(null)).toBe(false);
		expect(ThemeResources.isFontContentType(undefined)).toBe(false);
	});

	test("accepts images only", () => {
		expect(ThemeResources.isImageContentType("image/png")).toBe(true);
		expect(ThemeResources.isImageContentType("image/svg+xml")).toBe(true);
		expect(ThemeResources.isImageContentType("font/woff2")).toBe(false);
		expect(ThemeResources.isImageContentType(null)).toBe(false);
	});
});

describe("ThemeResources.describe", () => {
	test("summarises a font pack with its origin", () => {
		const css = Array.from({ length: 13 }, (_, i) => `@font-face { src: url(https://github.com/o/r/raw/main/fonts/f${i}.woff2); }`).join("\n");
		expect(ThemeResources.of(css).describe()).toBe("loads 13 files, 13 fonts, from github.com");
	});

	test("says nothing when a theme loads nothing", () => {
		expect(ThemeResources.of("").describe()).toBeUndefined();
	});

	test("counts an imported stylesheet", () => {
		const resources = ThemeResources.of("@import url(https://cdn.example.com/x.css);", "https://a.test/t.css");
		expect(resources.describe()).toBe("loads 1 file, 1 imported stylesheet, from cdn.example.com");
	});

	test("does not count an image, which the row only needs as part of the total", () => {
		const resources = ThemeResources.of(".a{background:url(https://img.example.com/a.png)}", "https://a.test/t.css");
		expect(resources.describe()).toBe("loads 1 file, from img.example.com");
	});
});

describe("ThemeResources.consent", () => {
	// The font pack is the case this exists for: 13 binaries from one host, installed by pasting one url
	const fontPack = Array.from({ length: 13 }, (_, i) => `@font-face { src: url(https://github.com/o/r/raw/main/fonts/Tech${i}.woff2); }`).join(
		"\n",
	);

	test("asks before downloading a font pack and names every file", () => {
		const consent = ThemeResources.of(fontPack).consent("Techroundpack");
		expect(consent.required).toBe(true);
		expect(consent.title).toBe("This theme downloads files");
		expect(consent.description).toBe(
			"Techroundpack downloads 13 files from github.com (13 fonts). Anything it downloads can change later without asking again.",
		);
		expect(consent.confirmationText).toBe("Install theme");
		// Every file is named, and grouped under the host it comes from
		expect(consent.hosts).toHaveLength(1);
		expect(consent.hosts[0].host).toBe("github.com");
		expect(consent.hosts[0].files).toHaveLength(12);
		expect(consent.hosts[0].hidden).toBe(1);
		expect(consent.hosts[0].files[0].label).toBe("Tech0.woff2");
	});

	test("lists a file once even when several @font-face rules name it", () => {
		// The real font pack names BOXRounded-Bold.ttf four times
		const css = Array.from({ length: 4 }, () => "@font-face { src: url(https://github.com/o/r/raw/main/f/Bold.ttf); }").join("\n");
		const consent = ThemeResources.of(css).consent("Pack");
		expect(consent.hosts[0].files).toHaveLength(1);
		expect(consent.hosts[0].hidden).toBe(0);
		// The count still reports what the css asks for, since that is what the browser will request
		expect(consent.description).toContain("4 files from github.com");
		expect(consent.hosts[0].files[0].url).toContain("github.com");
	});

	test("does not ask for a theme that loads nothing", () => {
		const consent = ThemeResources.of(":root { --a: 1; }").consent("Cottoncandy");
		expect(consent).toEqual({ required: false, title: "", description: "", hosts: [], confirmationText: "" });
	});

	test("does not count a data url, which is inside the css already", () => {
		expect(ThemeResources.of(".a{background:url(data:image/png;base64,AAAA)}").consent("x").required).toBe(false);
	});

	test("groups by host, sorted, with the file name as the label", () => {
		const css = `
			@import url(https://cdn.example.com/deep/path/extra.css);
			.a { background: url(https://img.example.com/bg.png); }
			@font-face { src: url(https://fonts.example.com/x.woff2); }
		`;
		const consent = ThemeResources.of(css, "https://a.test/t.css").consent("Multi");
		expect(consent.description).toContain("3 files from cdn.example.com, fonts.example.com, img.example.com");
		expect(consent.hosts.map((host) => host.host)).toEqual(["cdn.example.com", "fonts.example.com", "img.example.com"]);
		// The label is the file, not the url's folders
		expect(consent.hosts[0].files[0].label).toBe("extra.css");
	});

	test("lists at most 12 files in total and counts the rest as hidden", () => {
		const many = Array.from({ length: 5 }, (_, i) => `@font-face { src: url(https://a.test/f${i}.woff2); }`).join("\n");
		const alsoMany = Array.from({ length: 10 }, (_, i) => `@font-face { src: url(https://b.test/g${i}.woff2); }`).join("\n");
		const consent = ThemeResources.of(many + alsoMany).consent("Many");
		const listed = consent.hosts.reduce((total, host) => total + host.files.length, 0);
		const hidden = consent.hosts.reduce((total, host) => total + host.hidden, 0);
		expect(listed).toBe(12);
		expect(hidden).toBe(3);
		// The budget runs out in host order, so the second host is the one that is cut short
		expect(consent.hosts[0].hidden).toBe(0);
		expect(consent.hosts[1].hidden).toBe(3);
	});

	test("says file and font in the singular for one", () => {
		const css = "@font-face { src: url(https://fonts.example.com/x.woff2); }";
		expect(ThemeResources.of(css).consent("One").description).toBe(
			"One downloads 1 file from fonts.example.com (1 font). Anything it downloads can change later without asking again.",
		);
	});

	test("counts an image in the description", () => {
		const css = ".a{background:url(https://img.example.com/a.png)}";
		expect(ThemeResources.of(css).consent("Pic").description).toBe(
			"Pic downloads 1 file from img.example.com (1 image). Anything it downloads can change later without asking again.",
		);
	});
});

describe("ThemeResources.check", () => {
	const font = (n: number) => ThemeResources.of(`@font-face { src: url(https://github.com/o/r/raw/main/f/f${n}.woff2); }`);

	test("checks every file, with no cutoff", async () => {
		// A cap is exploitable: twenty harmless files and then the hostile one never gets looked at
		const resources = Array.from({ length: 60 }, (_, i) => font(i).resources).flat();
		const seen: string[] = [];
		stubFetch((url) => {
			seen.push(url);
			return response(200, "font/woff2");
		});
		const failures = await new ThemeResources(resources).check();
		expect(failures).toEqual([]);
		expect(seen).toHaveLength(60);
	});

	test("flags a bad file that sits past the old cutoff", async () => {
		const resources = Array.from({ length: 40 }, (_, i) => font(i).resources).flat();
		const bad = resources[39].absolute!;
		stubFetch((url) => response(200, url === bad ? "text/html" : "font/woff2"));
		const failures = await new ThemeResources(resources).check();
		expect(failures).toHaveLength(1);
		expect(failures[0].resource.absolute).toBe(bad);
		expect(failures[0].error.message).toBe("is not a font (text/html)");
	});

	test("checks a repeated url once, since it is one download", async () => {
		const css = Array.from({ length: 4 }, () => "@font-face { src: url(https://github.com/o/r/raw/main/f/Bold.ttf); }").join("\n");
		let calls = 0;
		stubFetch(() => {
			calls++;
			return response(200, "font/ttf");
		});
		const failures = await ThemeResources.of(css).check();
		expect(calls).toBe(1);
		expect(failures).toEqual([]);
	});

	test("reports progress as each file finishes, and never more than the requests at once", async () => {
		const resources = Array.from({ length: 5 }, (_, i) => font(i).resources).flat();
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
		await new ThemeResources(resources).check((done, total) => {
			expect(total).toBe(5);
			progress.push(done);
		});
		// Every file reported exactly once, in order
		expect(progress).toEqual([1, 2, 3, 4, 5]);
		// And never more than the configured number at a time
		expect(peak).toBeLessThanOrEqual(6);
	});

	test("counts a failed request as a problem rather than stopping", async () => {
		const resources = Array.from({ length: 3 }, (_, i) => font(i).resources).flat();
		stubFetch((url) => {
			if (url.includes("f1")) throw new Error("network down");
			return response(200, "font/woff2");
		});
		const failures = await new ThemeResources(resources).check();
		expect(failures).toHaveLength(1);
		expect(failures[0].error.message).toBe("could not be checked");
		expect(failures[0].error.cause).toBeInstanceOf(Error);
	});

	test("flags a file that answers http 404, a font that is not a font, and a non-stylesheet import", async () => {
		const resources = ThemeResources.of(`
			@font-face { src: url(https://a.test/missing.woff2); }
			.a { background: url(https://a.test/pic.png); }
			@import url(https://a.test/extra.css);
		`).resources;
		stubFetch((url) => {
			if (url.includes("missing")) return response(404, "text/plain");
			if (url.includes("pic")) return response(200, "text/css");
			return response(200, "text/html");
		});
		const failures = await new ThemeResources(resources).check();
		// Files are checked several at a time, so the order they fail in is not fixed
		expect(failures.map((failure) => failure.error.message).sort()).toEqual(
			["answered HTTP 404", "is not a stylesheet (text/html)", "is not an image (text/css)"].sort(),
		);
	});

	test("says nothing was answered for a request that never got a response", async () => {
		const resources = font(0).resources;
		stubFetch(() => response(0, null));
		const failures = await new ThemeResources(resources).check();
		expect(failures[0].error.message).toBe("answered nothing");
	});

	test("reports a missing content type rather than passing it", async () => {
		const resources = font(0).resources;
		stubFetch(() => response(200, null));
		const failures = await new ThemeResources(resources).check();
		expect(failures[0].error.message).toBe("is not a font (no content type)");
	});

	test("does nothing, cleanly, for a theme that loads no files", async () => {
		stubFetch(() => response(200, "font/woff2"));
		expect(await ThemeResources.of("body{}").check()).toEqual([]);
	});

	test("accepts a remote image and an imported stylesheet that are what they claim", async () => {
		const resources = ThemeResources.of(`
			.a { background: url(https://a.test/pic.png); }
			@import url(https://a.test/extra.css);
		`).resources;
		stubFetch((url) => response(200, url.includes("pic") ? "image/png" : "text/css"));
		expect(await new ThemeResources(resources).check()).toEqual([]);
	});

	test("accepts a font from a host that sends it as a generic binary", async () => {
		stubFetch(() => response(200, "application/octet-stream"));
		expect(await font(0).check()).toEqual([]);
	});
});
