import { describe, expect, test } from "vitest";

import { ThemeManifest } from "./ThemeManifest";

describe("ThemeManifest.parse", () => {
	test("reads the decorated, comma-less manifest that actually ships", () => {
		// cotton-candy-colorways/base-windows.css, verbatim
		const css = `/* { * *
 "name": "cotton candy",
 "author": "Aya, featuring some modified work by Interstellar_1 (from her Tidal Light theme) and Acercandr0 (from their Lunallena theme)",
 "description": "colorful light theme for tidaluna"
 "license": "MIT License"
 * } */

body { color: red; }`;

		expect(ThemeManifest.parse(css)).toEqual({
			name: "cotton candy",
			author: "Aya, featuring some modified work by Interstellar_1 (from her Tidal Light theme) and Acercandr0 (from their Lunallena theme)",
			description: "colorful light theme for tidaluna",
		});
	});

	test("reads strict json", () => {
		const css = `/* {"name":"strict","author":"someone","description":"plain json"} */\nbody{}`;
		expect(ThemeManifest.parse(css)).toEqual({ name: "strict", author: "someone", description: "plain json" });
	});

	test("tolerates a trailing comma", () => {
		const css = `/* {"name":"trailing",} */\nbody{}`;
		expect(ThemeManifest.parse(css)?.name).toBe("trailing");
	});

	test("is undefined when there is no manifest: a plain banner comment", () => {
		// cotton-candy-colorways/cottoncandy.css starts with a banner, not json
		const css = `/* ===========================----COLOR VARIABLES----================================== */\n:root{ --a: 1; }`;
		expect(ThemeManifest.parse(css)).toBeUndefined();
	});

	test("is undefined when there is no comment at all", () => {
		expect(ThemeManifest.parse("body{color:red}")).toBeUndefined();
	});

	test("is undefined for an unterminated comment", () => {
		expect(ThemeManifest.parse('/* { "name": "x" }\nbody{}')).toBeUndefined();
	});

	test("is undefined for css whose comment is not json", () => {
		expect(ThemeManifest.parse("/* hello world */ body{}")).toBeUndefined();
	});

	test("is undefined for a manifest that is json-shaped but will not parse", () => {
		expect(ThemeManifest.parse("/* { nope } */ body{}")).toBeUndefined();
	});

	test("is undefined for a json array or a bare string", () => {
		expect(ThemeManifest.parse(`/* ["a"] */ body{}`)).toBeUndefined();
		expect(ThemeManifest.parse(`/* "just a string" */ body{}`)).toBeUndefined();
	});

	test("ignores non-string members instead of throwing while rendering", () => {
		// A manifest like this used to throw during render, killing the settings root
		const css = `/* {"name": {"x":1}, "author": ["a"], "description": 5} */\nbody{}`;
		expect(ThemeManifest.parse(css)).toEqual({ name: undefined, author: undefined, description: undefined });
	});

	test("is undefined for undefined css", () => {
		expect(ThemeManifest.parse(undefined)).toBeUndefined();
	});
});

describe("ThemeManifest.nameOf", () => {
	test("reads the file name", () => {
		expect(ThemeManifest.nameOf("https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/cottoncandy.css")).toBe(
			"Cottoncandy",
		);
	});

	test("decodes a percent-encoded space and keeps the file, not the folder", () => {
		expect(
			ThemeManifest.nameOf(
				"https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/pride%20collection/sourrainbowstrips.css",
			),
		).toBe("Sourrainbowstrips");
	});

	test("splits separators into words", () => {
		expect(ThemeManifest.nameOf("https://example.com/themes/base-windows.css")).toBe("Base Windows");
		expect(ThemeManifest.nameOf("https://example.com/themes/tech_round_pack.css")).toBe("Tech Round Pack");
	});

	test("falls back to the host when the url has no file name", () => {
		expect(ThemeManifest.nameOf("https://themes.example.com/")).toBe("themes.example.com");
	});

	test("falls back to the input when it is not a url", () => {
		expect(ThemeManifest.nameOf("not a url")).toBe("not a url");
	});
});

describe("ThemeManifest.sourceOf", () => {
	test("is the host plus the file name, in the form a row shows", () => {
		expect(ThemeManifest.sourceOf("https://tidaluna.dev/nightwave.css")).toBe("tidaluna.dev/nightwave.css");
	});

	test("drops the ref and folders, which read as the inside of a page rather than an install", () => {
		expect(ThemeManifest.sourceOf("https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/base-windows.css")).toBe(
			"raw.githubusercontent.com/base-windows.css",
		);
	});

	test("is the host when the url has no file name, and the input when it cannot be parsed", () => {
		expect(ThemeManifest.sourceOf("https://tidaluna.dev/")).toBe("tidaluna.dev");
		expect(ThemeManifest.sourceOf("not a url")).toBe("not a url");
	});
});

describe("ThemeManifest.hostOf", () => {
	test("is the host, for provenance on a card with no manifest", () => {
		expect(ThemeManifest.hostOf("https://raw.githubusercontent.com/a/b/main/c.css")).toBe("raw.githubusercontent.com");
	});

	test("is undefined for an unparseable url", () => {
		expect(ThemeManifest.hostOf("nonsense")).toBeUndefined();
	});
});

describe("ThemeManifest.repoOwnerOf", () => {
	// Themes are shared as files in a repo, so the owner identifies the author when the css names none
	test("reads the owner from a raw url, a page url and a bare repo url", () => {
		expect(
			ThemeManifest.repoOwnerOf("https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/base-windows.css"),
		).toBe("aya-zzz-zzz");
		expect(ThemeManifest.repoOwnerOf("https://github.com/aya-zzz-zzz/cottoncandynights/blob/main/fonts/techroundpack.css")).toBe("aya-zzz-zzz");
		expect(ThemeManifest.repoOwnerOf("https://github.com/Inrixia/TidaLuna")).toBe("Inrixia");
	});

	test("decodes an encoded owner", () => {
		expect(ThemeManifest.repoOwnerOf("https://github.com/some%20user/repo/blob/main/a.css")).toBe("some user");
	});

	test("is undefined on a host where a path segment is not an owner", () => {
		// Guessing an author for a generic host would be worse than showing none
		expect(ThemeManifest.repoOwnerOf("https://tidaluna.dev/nightwave.css")).toBeUndefined();
	});

	test("is undefined for an unparseable url or a path with no repo", () => {
		expect(ThemeManifest.repoOwnerOf("not a url")).toBeUndefined();
		expect(ThemeManifest.repoOwnerOf("https://github.com/")).toBeUndefined();
		expect(ThemeManifest.repoOwnerOf("https://github.com/only-owner")).toBeUndefined();
	});
});

describe("ThemeManifest.codeUrlOf", () => {
	test("turns a raw url with refs/heads into the page you can read", () => {
		expect(ThemeManifest.codeUrlOf("https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/base-windows.css")).toBe(
			"https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/base-windows.css",
		);
	});

	test("turns a raw url with a bare ref into the page you can read", () => {
		// What a pasted github page url becomes on install, so this has to work too
		expect(ThemeManifest.codeUrlOf("https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/main/base-windows.css")).toBe(
			"https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/base-windows.css",
		);
	});

	test("keeps a nested path", () => {
		expect(
			ThemeManifest.codeUrlOf(
				"https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/pride%20collection/sourrainbowstrips.css",
			),
		).toBe("https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/pride%20collection/sourrainbowstrips.css");
	});

	test("leaves a github page url alone", () => {
		const page = "https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/base-windows.css";
		expect(ThemeManifest.codeUrlOf(page)).toBe(page);
	});

	test("is undefined on a host that has no source page", () => {
		expect(ThemeManifest.codeUrlOf("https://tidaluna.dev/nightwave.css")).toBeUndefined();
	});

	test("is undefined when there is no file path to show", () => {
		expect(ThemeManifest.codeUrlOf("https://raw.githubusercontent.com/owner/repo/refs/heads/main")).toBeUndefined();
		expect(ThemeManifest.codeUrlOf("https://github.com/owner/repo")).toBeUndefined();
		expect(ThemeManifest.codeUrlOf("not a url")).toBeUndefined();
	});
});

describe("ThemeManifest.kindOf", () => {
	// Measured from the real files: @font-face means a font pack, many rules means a layout rework, mostly variables
	// means a palette
	test("a font pack is Fonts", () => {
		const css = "@font-face { font-family: Tech; src: url(https://x/y.woff2); }\nbody{font-family:Tech}";
		expect(ThemeManifest.kindOf(css)).toBe("Fonts");
	});

	test("a layout rework is Base", () => {
		// base-windows.css has 937 rule blocks
		const css = Array.from({ length: 100 }, (_, i) => `.rule-${i} { color: red; }`).join("\n");
		expect(ThemeManifest.kindOf(css)).toBe("Base");
	});

	test("a palette of variables is Colorway", () => {
		// cottoncandy.css has 14 blocks and 44 variables
		const css = ":root { --cover-Vib1: 255, 103, 235; --bg: 10, 10, 10; }\n.a{color:var(--bg)}";
		expect(ThemeManifest.kindOf(css)).toBe("Colorway");
	});

	test("is Theme when there is no css yet", () => {
		expect(ThemeManifest.kindOf(undefined)).toBe("Theme");
		expect(ThemeManifest.kindOf("")).toBe("Colorway");
	});
});

describe("ThemeManifest.of", () => {
	const noManifest = "https://raw.githubusercontent.com/aya-zzz-zzz/cottoncandy/refs/heads/main/fonts/techroundpack.css";

	test("uses the manifest when there is one", () => {
		const manifest = ThemeManifest.of(
			"https://example.com/base-windows.css",
			`/* {"name": "cotton candy", "author": "Aya", "description": "colorful light theme"} */\nbody{}`,
		);
		expect(manifest).toMatchObject({
			name: "cotton candy",
			author: "Aya",
			description: "colorful light theme",
			source: "example.com/base-windows.css",
			codeUrl: undefined,
		});
	});

	test("without a manifest, names the theme from its file and still carries its source", () => {
		// This is the case that used to render the whole url as the name
		const manifest = ThemeManifest.of(noManifest);
		expect(manifest).toMatchObject({
			name: "Techroundpack",
			// Attributed to the repo owner, since the css names no author
			author: "aya-zzz-zzz",
			// No substitute description: the source line says where it came from instead
			description: undefined,
			source: "raw.githubusercontent.com/techroundpack.css",
			codeUrl: "https://github.com/aya-zzz-zzz/cottoncandy/blob/main/fonts/techroundpack.css",
		});
	});

	test("treats a blank manifest name as missing", () => {
		const css = `/* {"name": "   ", "author": "", "description": ""} */\nbody{}`;
		expect(ThemeManifest.of(noManifest, css).name).toBe("Techroundpack");
		expect(ThemeManifest.of(noManifest, css).author).toBe("aya-zzz-zzz");
		expect(ThemeManifest.of(noManifest, css).description).toBeUndefined();
	});

	test("keeps the manifest name when only the other fields are missing", () => {
		const manifest = ThemeManifest.of(noManifest, `/* {"name": "cotton candy"} */\nbody{}`);
		expect(manifest.name).toBe("cotton candy");
		expect(manifest.description).toBeUndefined();
		expect(manifest.source).toBe("raw.githubusercontent.com/techroundpack.css");
	});
});
