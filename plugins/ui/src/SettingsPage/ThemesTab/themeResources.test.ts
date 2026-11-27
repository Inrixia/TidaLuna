import { describe, expect, test } from "vitest";

import {
	describeResources,
	isFontContentType,
	isImageContentType,
	parseThemeResources,
	resourceProblem,
	stylesheetProblem,
	themeConsent,
} from "./themeResources";

describe("stylesheetProblem", () => {
	test("accepts a real stylesheet", () => {
		expect(stylesheetProblem("body { color: red; }", "text/plain; charset=utf-8")).toBeUndefined();
		expect(stylesheetProblem(":root { --a: 1; }")).toBeUndefined();
	});

	test("refuses the html page github serves instead of a missing file", () => {
		// This is what a raw url for a missing file, and every /blob/ page, answers with
		expect(stylesheetProblem("<!DOCTYPE html>\n<html lang=en>...", "text/html")).toBe("the url returned a web page, not a stylesheet");
		expect(stylesheetProblem("  \n<html><body>404</body></html>")).toBe("the url returned a web page, not a stylesheet");
	});

	test("refuses json", () => {
		expect(stylesheetProblem('{"message":"Not Found"}', "application/json")).toBe("the url returned json, not a stylesheet");
		expect(stylesheetProblem("[1,2,3]")).toBe("the url returned json, not a stylesheet");
	});

	test("refuses an empty body, which restyles nothing", () => {
		expect(stylesheetProblem("   \n  ")).toBe("the url returned an empty body");
	});

	test("refuses a body with no rules or at-rules", () => {
		expect(stylesheetProblem("just some words")).toBe("the body does not look like css");
	});

	test("refuses a plain 404 body", () => {
		expect(stylesheetProblem("404: Not Found")).toBe("the url returned an error, not a stylesheet");
		expect(stylesheetProblem("Not Found")).toBe("the url returned an error, not a stylesheet");
	});

	test("accepts an at-rule only stylesheet", () => {
		expect(stylesheetProblem("@import 'x.css';")).toBeUndefined();
	});
});

describe("parseThemeResources", () => {
	test("finds the font files a font pack declares", () => {
		// The shape of techroundpack.css: 13 @font-face blocks with a remote url each
		const css = `
			@font-face { font-family: Tech; src: url(https://github.com/o/r/raw/refs/heads/main/fonts/tech/Dream.woff2) format("woff2"); }
			@font-face { font-family: Tech2; src: url("https://github.com/o/r/raw/refs/heads/main/fonts/tech/Mono.ttf") format("truetype"); }
		`;
		const resources = parseThemeResources(css);
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
		const resources = parseThemeResources(css, "https://themes.example.com/dir/base.css");
		expect(resources.map((resource) => resource.kind)).toEqual(["stylesheet", "image", "other", "font"]);
		expect(resources[0].imported).toBe(true);
		// A relative url is resolved against the theme's own url
		expect(resources[3].absolute).toBe("https://themes.example.com/fonts/x.woff2");
	});

	test("records a data url without treating it as remote", () => {
		const resources = parseThemeResources(".a{background:url(data:image/png;base64,AA)}", "https://x.test/a.css");
		expect(resources[0].kind).toBe("other");
		expect(describeResources(resources)).not.toContain("from");
	});

	test("finds nothing in plain css", () => {
		expect(parseThemeResources("body { color: red; }")).toEqual([]);
	});
});

describe("isFontContentType", () => {
	test("accepts the types hosts actually send fonts with", () => {
		expect(isFontContentType("font/woff2")).toBe(true);
		expect(isFontContentType("application/font-woff")).toBe(true);
		expect(isFontContentType("application/octet-stream")).toBe(true);
		expect(isFontContentType("font/ttf; charset=binary")).toBe(true);
	});

	test("rejects what is not a font", () => {
		expect(isFontContentType("text/html")).toBe(false);
		expect(isFontContentType("text/css")).toBe(false);
		expect(isFontContentType(null)).toBe(false);
		expect(isFontContentType(undefined)).toBe(false);
	});
});

describe("isImageContentType", () => {
	test("accepts images only", () => {
		expect(isImageContentType("image/png")).toBe(true);
		expect(isImageContentType("image/svg+xml")).toBe(true);
		expect(isImageContentType("font/woff2")).toBe(false);
	});
});

describe("resourceProblem", () => {
	const font = { url: "a.woff2", absolute: "https://x.test/a.woff2", kind: "font" as const, imported: false };

	test("says nothing about a font served as a font", () => {
		expect(resourceProblem(font, 200, "font/woff2")).toBeUndefined();
	});

	test("catches a font url that serves html", () => {
		// github serves an html error page for a missing file, and the theme then silently loses its font
		expect(resourceProblem(font, 200, "text/html")).toBe("is not a font (text/html)");
	});

	test("catches a font that answers 404", () => {
		expect(resourceProblem(font, 404, "text/plain")).toBe("answered HTTP 404");
		expect(resourceProblem(font, 0, null)).toBe("answered nothing");
	});

	test("catches an image url that serves a stylesheet", () => {
		const image = { ...font, url: "b.png", kind: "image" as const };
		expect(resourceProblem(image, 200, "text/css")).toBe("is not an image (text/css)");
	});

	test("catches an @import that is not a stylesheet", () => {
		const imported = { ...font, url: "c.css", kind: "stylesheet" as const, imported: true };
		expect(resourceProblem(imported, 200, "text/html")).toBe("is not a stylesheet (text/html)");
	});
});

describe("describeResources", () => {
	test("summarises a font pack with its origin", () => {
		const css = Array.from({ length: 13 }, (_, i) => `@font-face { src: url(https://github.com/o/r/raw/main/fonts/f${i}.woff2); }`).join("\n");
		expect(describeResources(parseThemeResources(css))).toBe("loads 13 files, 13 fonts, from github.com");
	});

	test("says nothing when a theme loads nothing", () => {
		expect(describeResources([])).toBeUndefined();
	});

	test("counts an imported stylesheet", () => {
		const resources = parseThemeResources("@import url(https://cdn.example.com/x.css);", "https://a.test/t.css");
		expect(describeResources(resources)).toBe("loads 1 file, 1 imported stylesheet, from cdn.example.com");
	});
});

describe("themeConsent", () => {
	// The font pack is the case this exists for: 13 binaries from one host, installed by pasting one url
	const fontPack = Array.from({ length: 13 }, (_, i) => `@font-face { src: url(https://github.com/o/r/raw/main/fonts/Tech${i}.woff2); }`).join(
		"\n",
	);

	test("asks before downloading a font pack and names every file", () => {
		const consent = themeConsent("Techroundpack", parseThemeResources(fontPack));
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
		const consent = themeConsent("Pack", parseThemeResources(css));
		expect(consent.hosts[0].files).toHaveLength(1);
		expect(consent.hosts[0].hidden).toBe(0);
		// The count still reports what the css asks for, since that is what the browser will request
		expect(consent.description).toContain("4 files from github.com");
		expect(consent.hosts[0].files[0].url).toContain("github.com");
	});

	test("does not ask for a theme that loads nothing", () => {
		const consent = themeConsent("Cottoncandy", parseThemeResources(":root { --a: 1; }"));
		expect(consent.required).toBe(false);
		expect(consent.hosts).toEqual([]);
	});

	test("does not count a data url, which is inside the css already", () => {
		const css = ".a{background:url(data:image/png;base64,AAAA)}";
		expect(themeConsent("x", parseThemeResources(css)).required).toBe(false);
	});

	test("groups by host, sorted, with the file name as the label", () => {
		const css = `
			@import url(https://cdn.example.com/deep/path/extra.css);
			.a { background: url(https://img.example.com/bg.png); }
			@font-face { src: url(https://fonts.example.com/x.woff2); }
		`;
		const consent = themeConsent("Multi", parseThemeResources(css, "https://a.test/t.css"));
		expect(consent.description).toContain("3 files from cdn.example.com, fonts.example.com, img.example.com");
		expect(consent.hosts.map((host) => host.host)).toEqual(["cdn.example.com", "fonts.example.com", "img.example.com"]);
		// The label is the file, not the url's folders
		expect(consent.hosts[0].files[0].label).toBe("extra.css");
	});

	test("lists at most 12 files in total and counts the rest as hidden", () => {
		const many = Array.from({ length: 5 }, (_, i) => `@font-face { src: url(https://a.test/f${i}.woff2); }`).join("\n");
		const alsoMany = Array.from({ length: 10 }, (_, i) => `@font-face { src: url(https://b.test/g${i}.woff2); }`).join("\n");
		const consent = themeConsent("Many", parseThemeResources(many + alsoMany));
		const listed = consent.hosts.reduce((total, host) => total + host.files.length, 0);
		const hidden = consent.hosts.reduce((total, host) => total + host.hidden, 0);
		expect(listed).toBe(12);
		expect(hidden).toBe(3);
	});

	test("says file and font in the singular for one", () => {
		const css = "@font-face { src: url(https://fonts.example.com/x.woff2); }";
		expect(themeConsent("One", parseThemeResources(css)).description).toBe(
			"One downloads 1 file from fonts.example.com (1 font). Anything it downloads can change later without asking again.",
		);
	});
});
