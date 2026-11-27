import { afterEach, describe, expect, test, vi } from "vitest";

import { LunaTheme, resourceProgress, themeUrlOf, type ThemeData } from "./LunaTheme";

/** The parts of a Response a theme reads, so a test can hand one over without a server */
const reply = (body: string, status = 200) => ({
	status,
	ok: status >= 200 && status < 300,
	text: async () => body,
	headers: { get: () => null },
});

const stubFetch = (fetch: (url: string) => unknown) =>
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => fetch(String(url))),
	);

const unloads = new Set<() => unknown>();
const data = (over: Partial<ThemeData> = {}): ThemeData => ({ enabled: true, ...over });

/** A theme taken over from a stored record, which is what every row and every test starts from */
const themeFor = (url: string, over: Partial<ThemeData> = {}) => LunaTheme.from(url, data(over), unloads);

/** The theme's own element, which is what actually restyles the page */
const styleFor = (url: string) => document.getElementById(url);

afterEach(() => {
	for (const theme of LunaTheme.all()) theme.remove();
	vi.unstubAllGlobals();
});

describe("themeUrlOf", () => {
	// A theme is shared as a file in a repo, and the link people copy is the page, not the file
	test("converts a blob url and the /raw/ link the Raw button gives", () => {
		expect(themeUrlOf("https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/base-windows.css")).toBe(
			"https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/main/base-windows.css",
		);
		expect(themeUrlOf("https://github.com/aya-zzz-zzz/cottoncandynights/raw/refs/heads/main/fonts/techroundpack.css")).toBe(
			"https://raw.githubusercontent.com/aya-zzz-zzz/cottoncandynights/main/fonts/techroundpack.css",
		);
		expect(themeUrlOf("https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/pride%20collection/sourrainbowstrips.css")).toBe(
			"https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/main/pride%20collection/sourrainbowstrips.css",
		);
	});

	test("converts a page url on the other forges too", () => {
		expect(themeUrlOf("https://gitlab.com/group/sub/repo/-/blob/main/theme.css")).toBe("https://gitlab.com/group/sub/repo/-/raw/main/theme.css");
		expect(themeUrlOf("https://codeberg.org/o/r/src/branch/main/theme.css")).toBe("https://codeberg.org/o/r/raw/branch/main/theme.css");
	});

	test("leaves an already raw url, another host, and a url that is not a file alone", () => {
		// The ref is normalised whichever way it was written, so one file has one url
		expect(themeUrlOf("https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/base-windows.css")).toBe(
			"https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/main/base-windows.css",
		);
		expect(themeUrlOf("https://tidaluna.dev/nightwave.css")).toBe("https://tidaluna.dev/nightwave.css");
		expect(themeUrlOf("https://github.com/aya-zzz-zzz/cotton-candy-colorways")).toBe("https://github.com/aya-zzz-zzz/cotton-candy-colorways");
	});
});

describe("LunaTheme url rules", () => {
	test("accepts an https css file, and keeps a query string that versions it", () => {
		expect(themeFor("https://themes.example.com/base.css").url).toBe("https://themes.example.com/base.css");
		expect(themeFor("https://themes.example.com/base.css?v=4").url).toBe("https://themes.example.com/base.css?v=4");
		expect(themeFor("https://themes.example.com/BASE.CSS").url).toBe("https://themes.example.com/BASE.CSS");
	});

	test("allows http on loopback, which is how a theme is developed", () => {
		expect(themeFor("http://localhost:3000/theme.css").url).toBe("http://localhost:3000/theme.css");
		expect(themeFor("http://127.0.0.1:3000/theme.css").url).toBe("http://127.0.0.1:3000/theme.css");
		expect(themeFor("http://[::1]:3000/theme.css").url).toBe("http://[::1]:3000/theme.css");
	});

	test("refuses plain http, because a theme restyles TIDAL's own page", () => {
		expect(() => themeFor("http://themes.example.com/base.css")).toThrow("A theme must be served over https");
		expect(() => themeFor("file:///C:/Windows/hosts.css")).toThrow("A theme must be served over https");
		expect(() => themeFor("data:text/css,body{color:red}")).toThrow("A theme must be served over https");
		expect(() => themeFor("ftp://example.com/theme.css")).toThrow("A theme must be served over https");
	});

	test("refuses a url that is not a css file, and one that is not a url", () => {
		expect(() => themeFor("https://themes.example.com/theme.js")).toThrow("A theme url must point at a .css file");
		expect(() => themeFor("https://themes.example.com/theme")).toThrow("A theme url must point at a .css file");
		expect(() => themeFor("not a url")).toThrow("That is not a url");
	});

	test("refuses a stored page url, which would store html as css", () => {
		expect(() => themeFor("https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/base-windows.css")).toThrow(
			"That theme is stored as a page, not the file behind it",
		);
		expect(() => themeFor("https://gitlab.com/group/repo/-/blob/main/theme.css")).toThrow(
			"That theme is stored as a page, not the file behind it",
		);
	});

	test("refuses stored css over the limit, whatever its url", () => {
		expect(() => themeFor("https://t.example.com/a.css", { css: "a".repeat(LunaTheme.maxCssBytes + 1) })).toThrow("over the ");
	});

	test("refuses stored css that is not a stylesheet, since a backup can hold an error page", () => {
		expect(() => themeFor("https://t.example.com/a.css", { css: "<!DOCTYPE html><html></html>" })).toThrow(
			"That url returned a web page, not a stylesheet",
		);
	});
});

describe("LunaTheme.from", () => {
	test("deduplicates on the url, so a theme is one instance", () => {
		const first = themeFor("https://t.example.com/a.css", { css: "body{}" });
		expect(themeFor("https://t.example.com/a.css")).toBe(first);
		expect(LunaTheme.themes.get("https://t.example.com/a.css")).toBe(first);
	});

	test("applies the stored css straight away, without asking the server", () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		themeFor("https://t.example.com/a.css", { css: "body{color:red}" });
		expect(styleFor("https://t.example.com/a.css")?.textContent).toBe("body{color:red}");
		expect(fetch).not.toHaveBeenCalled();
	});

	test("registers without applying when the stored theme is off", () => {
		themeFor("https://t.example.com/a.css", { enabled: false, css: "body{}" });
		expect(styleFor("https://t.example.com/a.css")).toBeNull();
		expect(LunaTheme.all()).toHaveLength(1);
	});

	test("refuses a record that should never have been written without leaving anything behind", () => {
		// The record is refused before an instance exists, so there is no StyleTag and no unload handler for a theme that
		// never was
		const registered = unloads.size;
		expect(() => themeFor("https://github.com/o/r/blob/main/a.css")).toThrow("That theme is stored as a page");
		expect(unloads.size).toBe(registered);
		expect(LunaTheme.all()).toHaveLength(0);
	});
});

describe("LunaTheme.loadFromStore", () => {
	test("takes over every record, and reports the ones that should never have been written", () => {
		const errors: [string, unknown][] = [];
		LunaTheme.loadFromStore(
			{ "https://t.example.com/a.css": data({ css: "body{}" }), "https://github.com/o/r/blob/main/b.css": data() },
			unloads,
			(url, error) => errors.push([url, error]),
		);
		expect(LunaTheme.themes.has("https://t.example.com/a.css")).toBe(true);
		// The bad record is reported and left alone rather than dropped, so its css is not lost
		expect(errors.map(([url]) => url)).toEqual(["https://github.com/o/r/blob/main/b.css"]);
		expect(errors[0][1]).toBeInstanceOf(Error);
	});
});

describe("LunaTheme.install", () => {
	const install = (url: string, themes: Record<string, ThemeData> = {}, askConsent?: () => Promise<boolean>) =>
		LunaTheme.install(url, themes, unloads, askConsent === undefined ? undefined : async () => askConsent());

	test("stores, applies and registers the theme", async () => {
		stubFetch(() => reply("body{color:red}"));
		const themes: Record<string, ThemeData> = {};
		const theme = await install("https://t.example.com/a.css", themes);

		expect(themes["https://t.example.com/a.css"]).toMatchObject({ enabled: true, css: "body{color:red}" });
		expect(LunaTheme.themes.get("https://t.example.com/a.css")).toBe(theme);
		expect(theme.css).toBe("body{color:red}");
	});

	test("trims the url it was given, since a paste carries whitespace", async () => {
		stubFetch(() => reply("body{}"));
		const theme = await install("  https://t.example.com/a.css  ");
		expect(theme.url).toBe("https://t.example.com/a.css");
	});

	test("refuses an empty url", async () => {
		await expect(install("   ")).rejects.toThrow("That theme url is empty");
	});

	test("a pasted github page url installs the raw file", async () => {
		stubFetch(() => reply("body{}"));
		const theme = await install("https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/cottoncandy.css");
		expect(theme.url).toBe("https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/main/cottoncandy.css");
	});

	test("refuses a theme that is already installed by url", async () => {
		stubFetch(() => reply("body{color:red}"));
		await install("https://t.example.com/a.css");
		await expect(install("https://t.example.com/a.css")).rejects.toThrow("That theme is already installed");
	});

	test("refuses a page url and its raw url, which are one file written two ways", async () => {
		// Both forms normalise to the same url, so the second is the theme already on the page
		stubFetch(() => reply("body{color:red}"));
		await install("https://github.com/o/r/blob/main/base.css");
		await expect(install("https://raw.githubusercontent.com/o/r/refs/heads/main/base.css")).rejects.toThrow("That theme is already installed");
	});

	test("refuses the same css under a different url, which is one theme served two ways", async () => {
		// A fork or a mirror serves the same bytes: the url differs but the theme is the one already on the page
		stubFetch(() => reply("\n body{color:red}\n"));
		await install("https://t.example.com/a.css");
		await expect(install("https://cdn.example.com/b.css")).rejects.toThrow("That theme is already installed as t.example.com/a.css");
	});

	test("refuses a url that does not answer with css", async () => {
		stubFetch(() => reply("<!DOCTYPE html><html>404</html>"));
		await expect(install("https://t.example.com/a.css")).rejects.toThrow("That url returned a web page, not a stylesheet");
	});

	test("refuses a body that says it is an error, an empty body, and words", async () => {
		stubFetch(() => reply("404: Not Found"));
		await expect(install("https://t.example.com/a.css")).rejects.toThrow("That url returned an error, not a stylesheet");
		stubFetch(() => reply("   "));
		await expect(install("https://t.example.com/b.css")).rejects.toThrow("That url returned an empty body");
		stubFetch(() => reply("just some words"));
		await expect(install("https://t.example.com/c.css")).rejects.toThrow("That url does not look like css");
	});

	test("refuses json", async () => {
		stubFetch(() => reply('{"message":"Not Found"}'));
		await expect(install("https://t.example.com/a.css")).rejects.toThrow("That url returned json, not a stylesheet");
	});

	test("refuses css over the size limit, since it is persisted and re-applied on every start", async () => {
		stubFetch(() => reply("a".repeat(LunaTheme.maxCssBytes + 1)));
		await expect(install("https://t.example.com/a.css")).rejects.toThrow(`over the ${LunaTheme.maxCssBytes} limit`);
	});

	test("refuses a url that cannot be loaded, saying which url it was", async () => {
		stubFetch(() => {
			throw new Error("offline");
		});
		await expect(install("https://t.example.com/a.css")).rejects.toThrow("Could not load that url: offline");
	});

	test("refuses a theme that downloads files when there is no way to ask", async () => {
		stubFetch(() => reply("@font-face { src: url(https://fonts.example.com/x.woff2); }"));
		const themes: Record<string, ThemeData> = {};
		await expect(install("https://t.example.com/a.css", themes)).rejects.toThrow(
			"This theme downloads files, and there is no way to ask about that here",
		);
		expect(themes).toEqual({});
	});

	test("refuses a theme whose files were not agreed to, and stores nothing", async () => {
		stubFetch(() => reply("@font-face { src: url(https://fonts.example.com/x.woff2); }"));
		const themes: Record<string, ThemeData> = {};
		await expect(install("https://t.example.com/a.css", themes, async () => false)).rejects.toThrow("Theme was not installed");
		expect(themes).toEqual({});
		expect(LunaTheme.themes.get("https://t.example.com/a.css")).toBeUndefined();
	});

	test("installs a theme that downloads files once they are agreed to", async () => {
		stubFetch((url) =>
			url.endsWith(".css")
				? reply("@font-face { src: url(https://fonts.example.com/x.woff2); }")
				: { status: 200, headers: { get: () => "font/woff2" } },
		);
		const themes: Record<string, ThemeData> = {};
		const theme = await install("https://t.example.com/a.css", themes, async () => true);
		expect(theme.data.enabled).toBe(true);
		expect(themes["https://t.example.com/a.css"]?.css).toContain("@font-face");
	});

	test("checks what the theme loads after installing it", async () => {
		// A font url that serves a web page leaves the theme looking broken for a reason nothing on screen explains
		const urls: string[] = [];
		stubFetch((url) => {
			urls.push(url);
			if (url.endsWith(".css")) return reply("@font-face { src: url(https://fonts.example.com/missing.woff2); }");
			return { status: 200, headers: { get: () => "text/html" } };
		});
		await install("https://t.example.com/a.css", {}, async () => true);
		await vi.waitFor(() => expect(urls).toContain("https://fonts.example.com/missing.woff2"));
	});
});

describe("LunaTheme.enable and disable", () => {
	test("disabling takes the css off the page but keeps it stored", () => {
		const theme = themeFor("https://t.example.com/a.css", { css: "body{}" });
		theme.disable();
		expect(theme.data.enabled).toBe(false);
		expect(theme.data.css).toBe("body{}");
		expect(styleFor("https://t.example.com/a.css")).toBeNull();
	});

	test("enabling puts the stored css back without a request", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const theme = themeFor("https://t.example.com/a.css", { enabled: false, css: "body{}" });
		await theme.enable();
		expect(theme.data.enabled).toBe(true);
		expect(styleFor("https://t.example.com/a.css")?.textContent).toBe("body{}");
		expect(fetch).not.toHaveBeenCalled();
	});

	test("enabling a theme with no css fetches it", async () => {
		stubFetch(() => reply("body{color:red}"));
		const theme = themeFor("https://t.example.com/a.css", { enabled: false });
		await theme.enable();
		expect(theme.css).toBe("body{color:red}");
	});
});

describe("LunaTheme.reload", () => {
	test("reads the file again and restyles the page", async () => {
		stubFetch(() => reply("body{color:blue}"));
		const theme = themeFor("https://t.example.com/a.css", { css: "body{color:red}" });
		await theme.reload();
		expect(theme.css).toBe("body{color:blue}");
		expect(theme.data.css).toBe("body{color:blue}");
		expect(styleFor("https://t.example.com/a.css")?.textContent).toBe("body{color:blue}");
	});

	test("stores without applying when the theme is off", async () => {
		stubFetch(() => reply("body{color:blue}"));
		const theme = themeFor("https://t.example.com/a.css", { enabled: false, css: "body{color:red}" });
		await theme.reload();
		expect(theme.data.css).toBe("body{color:blue}");
		expect(styleFor("https://t.example.com/a.css")).toBeNull();
	});

	test("turns the theme off when it cannot be read, rather than leaving the switch on with nothing applied", async () => {
		stubFetch(() => {
			throw new Error("offline");
		});
		const theme = themeFor("https://t.example.com/a.css", { css: "body{}" });
		await theme.reload();
		expect(theme.data.enabled).toBe(false);
		expect(styleFor("https://t.example.com/a.css")).toBeNull();
	});

	test("refuses css over the size limit without touching what is applied", async () => {
		stubFetch(() => reply("a".repeat(LunaTheme.maxCssBytes + 1)));
		const theme = themeFor("https://t.example.com/a.css", { css: "body{}" });
		await theme.reload();
		expect(theme.data.css).toBe("body{}");
		expect(theme.data.enabled).toBe(false);
	});
});

describe("LunaTheme.revalidate", () => {
	const theme = (css = "body{color:red}") => themeFor("https://t.example.com/a.css", { css });

	test("a 304 leaves the stored css and the page alone", async () => {
		const fetch = vi.fn(async () => reply("", 304));
		vi.stubGlobal("fetch", fetch);
		expect(await theme().revalidate()).toBe("unchanged");
		expect(fetch).toHaveBeenCalledOnce();
		expect(styleFor("https://t.example.com/a.css")?.textContent).toBe("body{color:red}");
	});

	test("the same bytes are not a change", async () => {
		stubFetch(() => reply("body{color:red}"));
		expect(await theme().revalidate()).toBe("unchanged");
	});

	test("changed css is stored and applied", async () => {
		stubFetch(() => reply("body{color:blue}"));
		const target = theme();
		expect(await target.revalidate()).toBe("updated");
		expect(target.data.css).toBe("body{color:blue}");
		expect(styleFor("https://t.example.com/a.css")?.textContent).toBe("body{color:blue}");
	});

	test("keeps the stored css when the request fails, so a theme never disappears because the network was down", async () => {
		stubFetch(() => {
			throw new Error("offline");
		});
		const target = theme();
		expect(await target.revalidate()).toBe("failed");
		expect(target.data.css).toBe("body{color:red}");
		expect(target.css).toBe("body{color:red}");
	});

	test("keeps the stored css on a non-ok status", async () => {
		stubFetch(() => reply("gone", 404));
		const target = theme();
		expect(await target.revalidate()).toBe("failed");
		expect(target.css).toBe("body{color:red}");
	});

	test("refuses css over the size limit", async () => {
		stubFetch(() => reply("a".repeat(LunaTheme.maxCssBytes + 1)));
		const target = theme();
		expect(await target.revalidate()).toBe("failed");
		expect(target.data.css).toBe("body{color:red}");
	});

	test("refuses a record over the limit without fetching it", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const target = theme();
		// What importing a settings backup can leave behind, which never went through the install box
		target.data.css = "a".repeat(LunaTheme.maxCssBytes + 1);
		expect(await target.revalidate()).toBe("failed");
		expect(fetch).not.toHaveBeenCalled();
	});

	test("does not ask about a theme that is off", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const target = themeFor("https://t.example.com/a.css", { enabled: false, css: "body{}" });
		expect(await target.revalidate()).toBe("unchanged");
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("LunaTheme.refreshAll", () => {
	test("checks every enabled theme, including each package of a multi-part theme", async () => {
		stubFetch(() => reply("body{v2}"));
		const base = themeFor("https://t.example.com/base.css", { css: "body{base}" });
		const part2 = themeFor("https://t.example.com/part2.css", { css: "body{part2}" });
		const fonts = themeFor("https://t.example.com/fonts.css", { css: "body{fonts}" });
		const addon = themeFor("https://t.example.com/addon.css", { enabled: false, css: "body{addon}" });

		const summary = await LunaTheme.refreshAll();
		expect(summary.checked).toBe(3);
		expect(summary.updated).toEqual([base, part2, fonts]);
		expect(summary.unchanged).toBe(0);
		expect(summary.failed).toEqual([]);
		// The disabled one is untouched
		expect(addon.data.css).toBe("body{addon}");
		expect(styleFor("https://t.example.com/addon.css")).toBeNull();
	});

	test("counts failures without stopping the others", async () => {
		stubFetch((url) => {
			if (url.includes("a.css")) throw new Error("offline");
			return reply("body{b2}");
		});
		const first = themeFor("https://t.example.com/a.css", { css: "body{a}" });
		const second = themeFor("https://t.example.com/b.css", { css: "body{b}" });

		const summary = await LunaTheme.refreshAll();
		expect(summary.checked).toBe(2);
		expect(summary.updated).toEqual([second]);
		expect(summary.failed).toEqual([first]);
		expect(second.data.css).toBe("body{b2}");
	});

	test("counts unchanged themes without restyling them", async () => {
		stubFetch(() => reply("body{same}"));
		themeFor("https://t.example.com/a.css", { css: "body{same}" });
		themeFor("https://t.example.com/b.css", { css: "body{same}" });

		const summary = await LunaTheme.refreshAll();
		expect(summary).toMatchObject({ checked: 2, unchanged: 2, updated: [], failed: [] });
	});

	test("with no themes installed does nothing", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		expect(await LunaTheme.refreshAll()).toEqual({ checked: 0, unchanged: 0, updated: [], failed: [] });
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("what a row shows", () => {
	test("parses the manifest once and keeps it until the css changes", () => {
		const css = `/* {"name":"cotton candy","author":"Aya"} */\nbody{}`;
		const theme = themeFor("https://t.example.com/base-windows.css", { css });
		expect(theme.manifest).toBe(theme.manifest);
		expect(theme.manifest).toMatchObject({ name: "cotton candy", author: "Aya", source: "t.example.com/base-windows.css" });
	});

	test("falls back to the file name and the repo owner when there is no manifest", () => {
		const theme = themeFor("https://raw.githubusercontent.com/aya-zzz-zzz/cottoncandynights/refs/heads/main/fonts/techroundpack.css", {
			css: "@font-face { src: url(https://x.test/a.woff2); }",
		});
		expect(theme.manifest).toMatchObject({
			name: "Techroundpack",
			author: "aya-zzz-zzz",
			source: "raw.githubusercontent.com/techroundpack.css",
			codeUrl: "https://github.com/aya-zzz-zzz/cottoncandynights/blob/main/fonts/techroundpack.css",
		});
		expect(theme.manifest.kind).toBe("Fonts");
	});

	test("reads what the theme loads once", () => {
		const css = "@font-face { src: url(https://github.com/o/r/raw/main/f.woff2); }";
		const theme = themeFor("https://t.example.com/a.css", { css });
		expect(theme.resources).toBe(theme.resources);
		expect(theme.resources.describe()).toBe("loads 1 file, 1 font, from github.com");
	});

	test("re-reads them after a reload, since the file may have changed", async () => {
		stubFetch(() => reply("@font-face { src: url(https://github.com/o/r/raw/main/f.woff2); }"));
		const theme = themeFor("https://t.example.com/a.css", { css: "body{}" });
		expect(theme.resources.describe()).toBeUndefined();
		await theme.reload();
		expect(theme.resources.describe()).toBe("loads 1 file, 1 font, from github.com");
	});

	test("reads nothing out of a theme that has no css yet", () => {
		const theme = themeFor("https://t.example.com/a.css", { enabled: false });
		expect(theme.resources.describe()).toBeUndefined();
		expect(theme.resources.remote).toEqual([]);
		expect(theme.manifest.kind).toBe("Theme");
		expect(theme.manifest.name).toBe("A");
	});
});

describe("LunaTheme.check", () => {
	test("says nothing for a theme that loads no files", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await themeFor("https://t.example.com/a.css", { css: "body{}" }).check();
		expect(fetch).not.toHaveBeenCalled();
	});

	test("reports progress on the row and clears it afterwards", async () => {
		const seen: { done: number; total: number }[] = [];
		const theme = themeFor("https://t.example.com/a.css", { css: "@font-face { src: url(https://a.test/x.woff2); }" });
		const stop = resourceProgress.onValue((all) => {
			const progress = all["https://t.example.com/a.css"];
			if (progress !== undefined) seen.push(progress);
		});
		stubFetch(() => ({ status: 200, headers: { get: () => "font/woff2" } }));
		await theme.check();
		await stop();
		expect(seen[seen.length - 1]).toEqual({ done: 1, total: 1 });
		expect(resourceProgress._["https://t.example.com/a.css"]).toBeUndefined();
	});

	test("throws on a file that is not what the css says it is", async () => {
		stubFetch(() => ({ status: 200, headers: { get: () => "text/html" } }));
		await expect(themeFor("https://t.example.com/a.css", { css: "@font-face { src: url(https://a.test/x.woff2); }" }).check()).rejects.toThrow(
			"is not a font (text/html)",
		);
	});

	test("clears the row's progress even when the check failed", async () => {
		// The failure is reported, and the row goes back to its normal line rather than sitting on "checking 1 of 1" forever
		const theme = themeFor("https://t.example.com/a.css", { css: "@font-face { src: url(https://a.test/x.woff2); }" });
		stubFetch(() => ({ status: 200, headers: { get: () => "text/html" } }));
		await expect(theme.check()).rejects.toThrow("is not a font");
		expect(resourceProgress._["https://t.example.com/a.css"]).toBeUndefined();
	});
});

describe("LunaTheme.findByCss", () => {
	test("finds the theme with the same css, ignoring the url it was asked about", () => {
		const theme = themeFor("https://t.example.com/a.css", { css: "body{color:red}" });
		expect(LunaTheme.findByCss("  body{color:red}\n")).toBe(theme);
		expect(LunaTheme.findByCss("body{color:red}", "https://t.example.com/a.css")).toBeUndefined();
		expect(LunaTheme.findByCss("body{color:blue}")).toBeUndefined();
	});
});

describe("LunaTheme.remove", () => {
	test("takes the css off the page and forgets the theme", () => {
		const theme = themeFor("https://t.example.com/a.css", { css: "body{}" });
		theme.remove();
		expect(styleFor("https://t.example.com/a.css")).toBeNull();
		expect(LunaTheme.themes.get("https://t.example.com/a.css")).toBeUndefined();
		expect(LunaTheme.all()).toEqual([]);
	});
});
