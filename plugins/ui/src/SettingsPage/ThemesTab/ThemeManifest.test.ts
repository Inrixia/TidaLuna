import { describe, expect, test } from "vitest";

import { ThemeManifest } from "./ThemeManifest";

/** A read-through url, which is what a theme installed from a github page url ends up as */
const fontPack = "https://raw.githubusercontent.com/aya-zzz-zzz/cottoncandy/refs/heads/main/fonts/techroundpack.css";

describe("ThemeManifest manifest comments", () => {
	test("reads the decorated, comma-less manifest that actually ships", () => {
		// cotton-candy-colorways/base-windows.css, verbatim
		const css = `/* { * *
 "name": "cotton candy",
 "author": "Aya, featuring some modified work by Interstellar_1 (from her Tidal Light theme) and Acercandr0 (from their Lunallena theme)",
 "description": "colorful light theme for tidaluna"
 "license": "MIT License"
 * } */

body { color: red; }`;
		const manifest = ThemeManifest.from("https://example.com/base-windows.css", css);
		expect(manifest).toMatchObject({
			name: "cotton candy",
			author: "Aya, featuring some modified work by Interstellar_1 (from her Tidal Light theme) and Acercandr0 (from their Lunallena theme)",
			description: "colorful light theme for tidaluna",
		});
	});

	test("reads strict json", () => {
		const css = `/* {"name":"strict","author":"someone","description":"plain json"} */\nbody{}`;
		expect(ThemeManifest.from("https://example.com/a.css", css)).toMatchObject({ name: "strict", author: "someone", description: "plain json" });
	});

	test("tolerates a trailing comma", () => {
		expect(ThemeManifest.from("https://example.com/a.css", `/* {"name":"trailing",} */\nbody{}`).name).toBe("trailing");
	});

	test("falls back to the file name for a banner comment, no comment, an unterminated one, or words", () => {
		const url = "https://example.com/themes/cottoncandy.css";
		// cotton-candy-colorways/cottoncandy.css starts with a banner, not json
		expect(ThemeManifest.from(url, `/* =====----COLOR VARIABLES----===== */\n:root{ --a: 1; }`).name).toBe("Cottoncandy");
		expect(ThemeManifest.from(url, "body{color:red}").name).toBe("Cottoncandy");
		expect(ThemeManifest.from(url, '/* { "name": "x" }\nbody{}').name).toBe("Cottoncandy");
		expect(ThemeManifest.from(url, "/* hello world */ body{}").name).toBe("Cottoncandy");
	});

	test("falls back to the file name for a manifest that is json-shaped but will not parse, an array, or a bare string", () => {
		const url = "https://example.com/themes/cottoncandy.css";
		expect(ThemeManifest.from(url, "/* { nope } */ body{}").name).toBe("Cottoncandy");
		expect(ThemeManifest.from(url, `/* ["a"] */ body{}`).name).toBe("Cottoncandy");
		expect(ThemeManifest.from(url, `/* "just a string" */ body{}`).name).toBe("Cottoncandy");
	});

	test("ignores non-string members instead of throwing while rendering", () => {
		// A manifest like this used to throw during render, killing the settings root
		const css = `/* {"name": {"x":1}, "author": ["a"], "description": 5} */\nbody{}`;
		const manifest = ThemeManifest.from("https://example.com/themes/nightwave.css", css);
		expect(manifest.name).toBe("Nightwave");
		expect(manifest.author).toBeUndefined();
		expect(manifest.description).toBeUndefined();
	});

	test("treats a blank field as missing", () => {
		const css = `/* {"name": "   ", "author": "", "description": ""} */\nbody{}`;
		const manifest = ThemeManifest.from(fontPack, css);
		expect(manifest.name).toBe("Techroundpack");
		expect(manifest.author).toBe("aya-zzz-zzz");
		expect(manifest.description).toBeUndefined();
	});

	test("keeps the manifest name when only the other fields are missing", () => {
		const manifest = ThemeManifest.from(fontPack, `/* {"name": "cotton candy"} */\nbody{}`);
		expect(manifest.name).toBe("cotton candy");
		expect(manifest.description).toBeUndefined();
		expect(manifest.source).toBe("raw.githubusercontent.com/techroundpack.css");
	});
});

describe("ThemeManifest name and source", () => {
	test("reads the file name, decoding a percent-encoded space and keeping the file rather than the folder", () => {
		expect(
			ThemeManifest.from("https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/pride%20collection/sourrainbowstrips.css")
				.name,
		).toBe("Sourrainbowstrips");
	});

	test("splits separators into words", () => {
		expect(ThemeManifest.from("https://example.com/themes/base-windows.css").name).toBe("Base Windows");
		expect(ThemeManifest.from("https://example.com/themes/tech_round_pack.css").name).toBe("Tech Round Pack");
	});

	test("falls back to the host when the url has no file name, and to the input when it is not a url", () => {
		expect(ThemeManifest.from("https://themes.example.com/").name).toBe("themes.example.com");
		expect(ThemeManifest.from("not a url").name).toBe("not a url");
	});

	test("source is the host plus the file name, with the ref and folders dropped", () => {
		expect(ThemeManifest.from("https://tidaluna.dev/nightwave.css").source).toBe("tidaluna.dev/nightwave.css");
		expect(ThemeManifest.from(fontPack).source).toBe("raw.githubusercontent.com/techroundpack.css");
		expect(ThemeManifest.from("https://themes.example.com/").source).toBe("themes.example.com");
		expect(ThemeManifest.from("not a url").source).toBe("not a url");
	});
});

describe("ThemeManifest author and source page", () => {
	test("reads the repo owner from a raw url and a page url", () => {
		expect(ThemeManifest.from(fontPack).author).toBe("aya-zzz-zzz");
		expect(ThemeManifest.from("https://github.com/aya-zzz-zzz/cottoncandynights/blob/main/fonts/techroundpack.css").author).toBe("aya-zzz-zzz");
		// The other forges name the owner the same way, and gitlab keeps a subgroup in it
		expect(ThemeManifest.from("https://gitlab.com/group/sub/repo/-/raw/main/theme.css").author).toBe("group/sub");
	});

	test("decodes an encoded owner", () => {
		expect(ThemeManifest.from("https://github.com/some%20user/repo/blob/main/a.css").author).toBe("some user");
	});

	test("has no author on a host where a path segment is not an owner, or where there is no file in a repository", () => {
		// Guessing an author for a generic host would be worse than showing none
		expect(ThemeManifest.from("https://tidaluna.dev/nightwave.css").author).toBeUndefined();
		expect(ThemeManifest.from("https://themes.example.com/packs/nightwave.css").author).toBeUndefined();
		expect(ThemeManifest.from("https://github.com/Inrixia/TidaLuna").author).toBeUndefined();
	});

	test("has the page a theme's source can be read on", () => {
		expect(ThemeManifest.from(fontPack).codeUrl).toBe("https://github.com/aya-zzz-zzz/cottoncandy/blob/main/fonts/techroundpack.css");
		const page = "https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/base-windows.css";
		expect(ThemeManifest.from(page).codeUrl).toBe(page);
		expect(ThemeManifest.from("https://tidaluna.dev/nightwave.css").codeUrl).toBeUndefined();
	});

	test("keeps the git file it was read from, and only for a file", () => {
		const manifest = ThemeManifest.from(fontPack);
		expect(manifest.git).toMatchObject({ owner: "aya-zzz-zzz", repo: "cottoncandy", ref: "main", path: "fonts/techroundpack.css" });
		expect(ThemeManifest.from("https://tidaluna.dev/nightwave.css").git).toBeUndefined();
		expect(ThemeManifest.from("https://github.com/o/r").git).toBeUndefined();
	});
});

describe("ThemeManifest kind", () => {
	test("a font pack is Fonts", () => {
		const css = "@font-face { font-family: Tech; src: url(https://x/y.woff2); }\nbody{font-family:Tech}";
		expect(ThemeManifest.from("https://example.com/a.css", css).kind).toBe("Fonts");
	});

	test("a layout rework is Base", () => {
		// base-windows.css has 937 rule blocks
		const css = Array.from({ length: 100 }, (_, i) => `.rule-${i} { color: red; }`).join("\n");
		expect(ThemeManifest.from("https://example.com/a.css", css).kind).toBe("Base");
	});

	test("a palette of variables is Colorway", () => {
		// cottoncandy.css has 14 blocks and 44 variables
		const css = ":root { --cover-Vib1: 255, 103, 235; --bg: 10, 10, 10; }\n.a{color:var(--bg)}";
		expect(ThemeManifest.from("https://example.com/a.css", css).kind).toBe("Colorway");
	});

	test("is Theme when there is no css yet, and Colourway for empty css", () => {
		expect(ThemeManifest.from("https://example.com/a.css").kind).toBe("Theme");
		expect(ThemeManifest.from("https://example.com/a.css", "").kind).toBe("Colorway");
	});
});

describe("ThemeManifest.from", () => {
	test("uses the manifest when there is one, and carries the source", () => {
		const manifest = ThemeManifest.from(
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
		const manifest = ThemeManifest.from(fontPack);
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

	test("is created once per url and css, so a row, a toast and a refresh share it", () => {
		const css = `/* {"name":"cotton candy"} */\nbody{}`;
		expect(ThemeManifest.from(fontPack, css)).toBe(ThemeManifest.from(fontPack, css));
		// A different css is a different manifest, since the css is what it was read from
		expect(ThemeManifest.from(fontPack, css)).not.toBe(ThemeManifest.from(fontPack, "body{}"));
	});
});
