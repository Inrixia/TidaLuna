import { describe, expect, test } from "vitest";

import {
	parseThemeManifest,
	themeCodeUrl,
	themeDisplay,
	themeHost,
	themeKind,
	themeNameFromUrl,
	themeRepoOwner,
	themeSource,
} from "./themeManifest";

describe("parseThemeManifest", () => {
	test("reads the decorated, comma-less manifest that actually ships", () => {
		// cotton-candy-colorways/base-windows.css, verbatim
		const css = `/* { * *
 "name": "cotton candy",
 "author": "Aya, featuring some modified work by Interstellar_1 (from her Tidal Light theme) and Acercandr0 (from their Lunallena theme)",
 "description": "colorful light theme for tidaluna"
 "license": "MIT License"
 * } */

body { color: red; }`;

		expect(parseThemeManifest(css)).toEqual({
			name: "cotton candy",
			author: "Aya, featuring some modified work by Interstellar_1 (from her Tidal Light theme) and Acercandr0 (from their Lunallena theme)",
			description: "colorful light theme for tidaluna",
		});
	});

	test("reads strict json", () => {
		const css = `/* {"name":"strict","author":"someone","description":"plain json"} */\nbody{}`;
		expect(parseThemeManifest(css)).toEqual({ name: "strict", author: "someone", description: "plain json" });
	});

	test("tolerates a trailing comma", () => {
		const css = `/* {"name":"trailing",} */\nbody{}`;
		expect(parseThemeManifest(css)?.name).toBe("trailing");
	});

	test("is undefined when there is no manifest: a plain banner comment", () => {
		// cotton-candy-colorways/cottoncandy.css starts with a banner, not json
		const css = `/* ===========================----COLOR VARIABLES----================================== */\n:root{ --a: 1; }`;
		expect(parseThemeManifest(css)).toBeUndefined();
	});

	test("is undefined when there is no comment at all", () => {
		expect(parseThemeManifest("body{color:red}")).toBeUndefined();
	});

	test("is undefined for an unterminated comment", () => {
		expect(parseThemeManifest('/* { "name": "x" }\nbody{}')).toBeUndefined();
	});

	test("is undefined for css whose comment is not json", () => {
		expect(parseThemeManifest("/* hello world */ body{}")).toBeUndefined();
	});

	test("is undefined for a json array or a bare string", () => {
		expect(parseThemeManifest(`/* ["a"] */ body{}`)).toBeUndefined();
		expect(parseThemeManifest(`/* "just a string" */ body{}`)).toBeUndefined();
	});

	test("ignores non-string members instead of throwing while rendering", () => {
		// A manifest like this used to throw during render, killing the settings root
		const css = `/* {"name": {"x":1}, "author": ["a"], "description": 5} */\nbody{}`;
		expect(parseThemeManifest(css)).toEqual({ name: undefined, author: undefined, description: undefined });
	});

	test("is undefined for undefined css", () => {
		expect(parseThemeManifest(undefined)).toBeUndefined();
	});
});

describe("themeNameFromUrl", () => {
	test("reads the file name", () => {
		expect(themeNameFromUrl("https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/cottoncandy.css")).toBe(
			"Cottoncandy",
		);
	});

	test("decodes a percent-encoded space and keeps the file, not the folder", () => {
		expect(
			themeNameFromUrl(
				"https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/pride%20collection/sourrainbowstrips.css",
			),
		).toBe("Sourrainbowstrips");
	});

	test("splits separators into words", () => {
		expect(themeNameFromUrl("https://example.com/themes/base-windows.css")).toBe("Base Windows");
		expect(themeNameFromUrl("https://example.com/themes/tech_round_pack.css")).toBe("Tech Round Pack");
	});

	test("ignores a query string and hash", () => {
		expect(themeNameFromUrl("https://example.com/base-windows.css?v=2#dark")).toBe("Base Windows");
	});

	test("falls back to the host when the url has no file name", () => {
		expect(themeNameFromUrl("https://themes.example.com/")).toBe("themes.example.com");
	});

	test("falls back to the input when it is not a url", () => {
		expect(themeNameFromUrl("not a url")).toBe("not a url");
	});
});

describe("themeHost", () => {
	test("is the origin host, for provenance on a card with no manifest", () => {
		expect(themeHost("https://raw.githubusercontent.com/a/b/main/c.css")).toBe("raw.githubusercontent.com");
	});

	test("is undefined for an unparseable url", () => {
		expect(themeHost("nonsense")).toBeUndefined();
	});
});

describe("themeRepoOwner", () => {
	// Themes are shared as files in a repo, so the owner identifies the author when the css names none
	test("reads the owner from a raw.githubusercontent url", () => {
		expect(themeRepoOwner("https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/base-windows.css")).toBe(
			"aya-zzz-zzz",
		);
	});

	test("reads the owner from a github blob url", () => {
		expect(themeRepoOwner("https://github.com/aya-zzz-zzz/cottoncandynights/blob/main/fonts/techroundpack.css")).toBe("aya-zzz-zzz");
	});

	test("reads the owner from a bare repo url", () => {
		expect(themeRepoOwner("https://github.com/Inrixia/TidaLuna")).toBe("Inrixia");
	});

	test("decodes an encoded owner", () => {
		expect(themeRepoOwner("https://github.com/some%20user/repo/blob/main/a.css")).toBe("some user");
	});

	test("is undefined on a host where a path segment is not an owner", () => {
		// Guessing an author for a generic host would be worse than showing none
		expect(themeRepoOwner("https://tidaluna.dev/nightwave.css")).toBeUndefined();
	});

	test("is undefined for an unparseable url or an empty path", () => {
		expect(themeRepoOwner("not a url")).toBeUndefined();
		expect(themeRepoOwner("https://github.com/")).toBeUndefined();
	});
});

describe("themeCodeUrl", () => {
	test("turns a raw url with refs/heads into the page you can read", () => {
		expect(themeCodeUrl("https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/base-windows.css")).toBe(
			"https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/base-windows.css",
		);
	});

	test("turns a raw url with a bare ref into the page you can read", () => {
		// What a pasted github page url becomes on install, so this has to work too
		expect(themeCodeUrl("https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/main/base-windows.css")).toBe(
			"https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/base-windows.css",
		);
	});

	test("keeps a nested path", () => {
		expect(
			themeCodeUrl("https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/pride%20collection/sourrainbowstrips.css"),
		).toBe("https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/pride%20collection/sourrainbowstrips.css");
	});

	test("leaves a github page url alone", () => {
		const page = "https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/base-windows.css";
		expect(themeCodeUrl(page)).toBe(page);
	});

	test("is undefined on a host that has no source page", () => {
		expect(themeCodeUrl("https://tidaluna.dev/nightwave.css")).toBeUndefined();
	});

	test("is undefined when there is no file path to show", () => {
		expect(themeCodeUrl("https://raw.githubusercontent.com/owner/repo/refs/heads/main")).toBeUndefined();
		expect(themeCodeUrl("https://github.com/owner/repo")).toBeUndefined();
		expect(themeCodeUrl("not a url")).toBeUndefined();
	});
});

describe("themeSource", () => {
	test("is the host plus the file name, in the form a row shows", () => {
		expect(themeSource("https://tidaluna.dev/nightwave.css")).toBe("tidaluna.dev/nightwave.css");
	});

	test("drops the ref and folders, which read as the inside of a page rather than an install", () => {
		expect(themeSource("https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/base-windows.css")).toBe(
			"raw.githubusercontent.com/base-windows.css",
		);
	});

	test("decodes a percent-encoded file name", () => {
		expect(themeSource("https://example.com/collection/sour%20rainbow.css")).toBe("example.com/sour rainbow.css");
	});

	test("is the host when the url has no file name", () => {
		expect(themeSource("https://tidaluna.dev/")).toBe("tidaluna.dev");
	});

	test("is the input when it cannot be parsed", () => {
		expect(themeSource("not a url")).toBe("not a url");
	});
});

describe("themeKind", () => {
	// Measured from the real files: @font-face means a font pack, many rules means a layout rework, mostly variables
	// means a palette
	test("a font pack is Fonts", () => {
		const css = "@font-face { font-family: Tech; src: url(https://x/y.woff2); }\nbody{font-family:Tech}";
		expect(themeKind(css)).toBe("Fonts");
	});

	test("a layout rework is Base", () => {
		// base-windows.css has 937 rule blocks
		const css = Array.from({ length: 100 }, (_, i) => `.rule-${i} { color: red; }`).join("\n");
		expect(themeKind(css)).toBe("Base");
	});

	test("a palette of variables is Colorway", () => {
		// cottoncandy.css has 14 blocks and 44 variables
		const css = ":root { --cover-Vib1: 255, 103, 235; --bg: 10, 10, 10; }\n.a{color:var(--bg)}";
		expect(themeKind(css)).toBe("Colorway");
	});

	test("is Theme when there is no css yet", () => {
		expect(themeKind(undefined)).toBe("Theme");
		expect(themeKind("")).toBe("Colorway");
	});
});

describe("themeDisplay", () => {
	const noManifest = "https://raw.githubusercontent.com/aya-zzz-zzz/cottoncandy/refs/heads/main/fonts/techroundpack.css";

	test("uses the manifest when there is one", () => {
		const display = themeDisplay("https://example.com/base-windows.css", {
			name: "cotton candy",
			author: "Aya",
			description: "colorful light theme",
		});
		expect(display).toEqual({
			name: "cotton candy",
			author: "Aya",
			description: "colorful light theme",
			source: "example.com/base-windows.css",
		});
	});

	test("without a manifest, names the theme from its file and still carries its source", () => {
		// This is the case that used to render the whole url as the name
		expect(themeDisplay(noManifest)).toEqual({
			name: "Techroundpack",
			// Attributed to the repo owner, since the css names no author
			author: "aya-zzz-zzz",
			// No substitute description: the source line says where it came from instead
			description: undefined,
			source: "raw.githubusercontent.com/techroundpack.css",
		});
	});

	test("treats a blank manifest name as missing", () => {
		expect(themeDisplay(noManifest, { name: "   ", author: "", description: "" }).name).toBe("Techroundpack");
	});

	test("keeps the manifest name when only the other fields are missing", () => {
		const display = themeDisplay(noManifest, { name: "cotton candy" });
		expect(display.name).toBe("cotton candy");
		expect(display.description).toBeUndefined();
		expect(display.source).toBe("raw.githubusercontent.com/techroundpack.css");
	});
});
