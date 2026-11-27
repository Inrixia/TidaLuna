import { afterEach, describe, expect, test, vi } from "vitest";

import { Theme, resourceProgress, type ThemeData } from "./Theme";

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

/** The theme's own element, which is what actually restyles the page */
const styleFor = (url: string) => document.getElementById(url);

afterEach(() => {
	for (const theme of Theme.all()) theme.remove();
	vi.unstubAllGlobals();
});

describe("Theme.parseUrl", () => {
	test("accepts an https css file, and keeps a query string that versions it", () => {
		expect(Theme.parseUrl("https://themes.example.com/base.css")).toBe("https://themes.example.com/base.css");
		expect(Theme.parseUrl("https://themes.example.com/base.css?v=4")).toBe("https://themes.example.com/base.css?v=4");
		expect(Theme.parseUrl("  https://themes.example.com/base.css  ")).toBe("https://themes.example.com/base.css");
		expect(Theme.parseUrl("https://themes.example.com/BASE.CSS")).toBe("https://themes.example.com/BASE.CSS");
	});

	test("allows http on loopback, which is how a theme is developed", () => {
		expect(Theme.parseUrl("http://localhost:3000/theme.css")).toBe("http://localhost:3000/theme.css");
		expect(Theme.parseUrl("http://127.0.0.1:3000/theme.css")).toBe("http://127.0.0.1:3000/theme.css");
		expect(Theme.parseUrl("http://[::1]:3000/theme.css")).toBe("http://[::1]:3000/theme.css");
	});

	test("refuses plain http, because a theme restyles TIDAL's own page", () => {
		expect(() => Theme.parseUrl("http://themes.example.com/base.css")).toThrow("A theme must be served over https");
		expect(() => Theme.parseUrl("file:///C:/Windows/hosts.css")).toThrow("A theme must be served over https");
		expect(() => Theme.parseUrl("data:text/css,body{color:red}")).toThrow("A theme must be served over https");
		expect(() => Theme.parseUrl("ftp://example.com/theme.css")).toThrow("A theme must be served over https");
	});

	test("refuses a url that is not a css file, and one that is not a url", () => {
		expect(() => Theme.parseUrl("https://themes.example.com/theme.js")).toThrow("A theme url must point at a .css file");
		expect(() => Theme.parseUrl("https://themes.example.com/theme")).toThrow("A theme url must point at a .css file");
		expect(() => Theme.parseUrl("not a url")).toThrow("That is not a url");
		expect(() => Theme.parseUrl("   ")).toThrow("That theme url is empty");
	});

	test("a pasted github page url installs the raw file", () => {
		expect(Theme.parseUrl("https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/cottoncandy.css")).toBe(
			"https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/main/cottoncandy.css",
		);
	});
});

describe("Theme.rawUrlOf", () => {
	// A theme is shared as a file in a repo, and the link people copy is the page, not the file
	test("converts a blob url and the /raw/ link the Raw button gives", () => {
		expect(Theme.rawUrlOf("https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/base-windows.css")).toBe(
			"https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/main/base-windows.css",
		);
		expect(Theme.rawUrlOf("https://github.com/aya-zzz-zzz/cottoncandynights/raw/refs/heads/main/fonts/techroundpack.css")).toBe(
			"https://raw.githubusercontent.com/aya-zzz-zzz/cottoncandynights/refs/heads/main/fonts/techroundpack.css",
		);
		expect(Theme.rawUrlOf("https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/pride%20collection/sourrainbowstrips.css")).toBe(
			"https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/main/pride%20collection/sourrainbowstrips.css",
		);
	});

	test("leaves an already raw url, another host, and a github url that is not a file alone", () => {
		const raw = "https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/base-windows.css";
		expect(Theme.rawUrlOf(raw)).toBe(raw);
		expect(Theme.rawUrlOf("https://tidaluna.dev/nightwave.css")).toBe("https://tidaluna.dev/nightwave.css");
		const repo = "https://github.com/aya-zzz-zzz/cotton-candy-colorways";
		expect(Theme.rawUrlOf(repo)).toBe(repo);
		expect(() => Theme.parseUrl(repo)).toThrow("A theme url must point at a .css file");
		// A blob url with nothing after the kind is not a file, so there is nothing to convert it to
		expect(Theme.rawUrlOf("https://github.com/o/r/blob")).toBe("https://github.com/o/r/blob");
	});
});

describe("Theme.validateStored", () => {
	// A theme can be written by importing a settings backup or a luna-settings.json seed, neither of which goes through
	// the install box, so the check has to exist on the apply path too
	test("accepts a stored https css theme", () => {
		expect(() => Theme.validateStored("https://t.example.com/a.css", { enabled: true, css: "body{}" })).not.toThrow();
	});

	test("refuses a stored url that the install box would refuse", () => {
		expect(() => Theme.validateStored("data:text/css,body{}//x.css", data())).toThrow("A theme must be served over https");
		expect(() => Theme.validateStored("file:///C:/x.css", data())).toThrow("A theme must be served over https");
		expect(() => Theme.validateStored("https://t.example.com/a.js", data())).toThrow("A theme url must point at a .css file");
	});

	test("refuses a stored github page url, which would store html as css", () => {
		expect(() => Theme.validateStored("https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/base-windows.css", data())).toThrow(
			"That theme is stored as a github page, not the file behind it",
		);
	});

	test("refuses stored css over the limit, whatever its url", () => {
		expect(() => Theme.validateStored("https://t.example.com/a.css", data({ css: "a".repeat(Theme.maxCssBytes + 1) }))).toThrow("over the ");
	});
});

describe("Theme.resume", () => {
	test("applies the stored css straight away, without asking the server", () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const theme = Theme.resume("https://t.example.com/a.css", data({ css: "body{color:red}" }), unloads);

		expect(theme.data.enabled).toBe(true);
		expect(theme.css).toBe("body{color:red}");
		expect(styleFor("https://t.example.com/a.css")?.textContent).toBe("body{color:red}");
		expect(fetch).not.toHaveBeenCalled();
	});

	test("applies nothing for a disabled theme, but keeps what is stored", () => {
		const theme = Theme.resume("https://t.example.com/a.css", data({ enabled: false, css: "body{}" }), unloads);
		expect(theme.data.css).toBe("body{}");
		expect(styleFor("https://t.example.com/a.css")).toBeNull();
	});

	test("is the same theme when called twice, so a row and the startup agree on the object", () => {
		const url = "https://t.example.com/a.css";
		expect(Theme.resume(url, data({ css: "a{}" }), unloads)).toBe(Theme.resume(url, data({ css: "a{}" }), unloads));
		expect(Theme.get(url)).toBeDefined();
	});

	test("refuses a record that should never have been written, and registers nothing", () => {
		expect(() => Theme.resume("https://t.example.com/a.js", data(), unloads)).toThrow("A theme url must point at a .css file");
		expect(Theme.get("https://t.example.com/a.js")).toBeUndefined();
	});

	test("fetches the css for an enabled theme that never finished downloading", async () => {
		stubFetch(() => reply("body{color:blue}"));
		const theme = Theme.resume("https://t.example.com/a.css", data(), unloads);
		await vi.waitFor(() => expect(theme.css).toBe("body{color:blue}"));
		expect(theme.data.css).toBe("body{color:blue}");
	});
});

describe("Theme.install", () => {
	const install = (url: string, themes: Record<string, ThemeData> = {}, askConsent?: () => Promise<boolean>) =>
		Theme.install(url, themes, unloads, askConsent === undefined ? undefined : async () => askConsent());

	test("stores, applies and registers the theme", async () => {
		stubFetch(() => reply("body{color:red}"));
		const themes: Record<string, ThemeData> = {};
		const theme = await install("https://t.example.com/a.css", themes);

		expect(themes["https://t.example.com/a.css"]).toMatchObject({ enabled: true, css: "body{color:red}" });
		expect(Theme.get("https://t.example.com/a.css")).toBe(theme);
		expect(theme.css).toBe("body{color:red}");
	});

	test("refuses a theme that is already installed by url", async () => {
		stubFetch(() => reply("body{color:red}"));
		await install("https://t.example.com/a.css");
		await expect(install("https://t.example.com/a.css")).rejects.toThrow("That theme is already installed");
	});

	test("refuses the same css under a different url, which is one theme served two ways", async () => {
		// The same file is served at both of these, so installing one after the other applied 158KB of css twice
		stubFetch(() => reply("\n body{color:red}\n"));
		await install("https://raw.githubusercontent.com/o/r/refs/heads/main/base.css");
		await expect(install("https://raw.githubusercontent.com/o/r/main/base.css")).rejects.toThrow(
			"That theme is already installed as raw.githubusercontent.com/base.css",
		);
	});

	test("refuses a url that does not answer with css", async () => {
		stubFetch(() => reply("<!DOCTYPE html><html>404</html>"));
		await expect(install("https://t.example.com/a.css")).rejects.toThrow("That url returned a web page, not a stylesheet");
	});

	test("refuses css over the size limit, since it is persisted and re-applied on every start", async () => {
		stubFetch(() => reply("a".repeat(Theme.maxCssBytes + 1)));
		await expect(install("https://t.example.com/a.css")).rejects.toThrow(`over the ${Theme.maxCssBytes} limit`);
	});

	test("refuses a url that cannot be loaded, saying which url it was", async () => {
		stubFetch(() => {
			throw new Error("offline");
		});
		await expect(install("https://t.example.com/a.css")).rejects.toThrow("Could not load that url: offline");
	});

	test("says what was thrown even when it was not an Error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw "nope";
			}),
		);
		await expect(install("https://t.example.com/a.css")).rejects.toThrow("Could not load that url: nope");
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
		expect(Theme.get("https://t.example.com/a.css")).toBeUndefined();
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

describe("Theme.enable and disable", () => {
	test("disabling takes the css off the page but keeps it stored", () => {
		const theme = Theme.resume("https://t.example.com/a.css", data({ css: "body{}" }), unloads);
		theme.disable();
		expect(theme.data.enabled).toBe(false);
		expect(theme.data.css).toBe("body{}");
		expect(styleFor("https://t.example.com/a.css")).toBeNull();
	});

	test("enabling puts the stored css back without a request", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const theme = Theme.resume("https://t.example.com/a.css", data({ enabled: false, css: "body{}" }), unloads);
		await theme.enable();
		expect(theme.data.enabled).toBe(true);
		expect(styleFor("https://t.example.com/a.css")?.textContent).toBe("body{}");
		expect(fetch).not.toHaveBeenCalled();
	});

	test("enabling a theme with no css fetches it", async () => {
		stubFetch(() => reply("body{color:red}"));
		const theme = Theme.resume("https://t.example.com/a.css", data({ enabled: false }), unloads);
		await theme.enable();
		expect(theme.css).toBe("body{color:red}");
	});
});

describe("Theme.reload", () => {
	test("reads the file again and restyles the page", async () => {
		stubFetch(() => reply("body{color:blue}"));
		const theme = Theme.resume("https://t.example.com/a.css", data({ css: "body{color:red}" }), unloads);
		await theme.reload();
		expect(theme.css).toBe("body{color:blue}");
		expect(theme.data.css).toBe("body{color:blue}");
		expect(styleFor("https://t.example.com/a.css")?.textContent).toBe("body{color:blue}");
	});

	test("stores without applying when the theme is off", async () => {
		stubFetch(() => reply("body{color:blue}"));
		const theme = Theme.resume("https://t.example.com/a.css", data({ enabled: false, css: "body{color:red}" }), unloads);
		await theme.reload();
		expect(theme.data.css).toBe("body{color:blue}");
		expect(styleFor("https://t.example.com/a.css")).toBeNull();
	});

	test("turns the theme off when it cannot be read, rather than leaving the switch on with nothing applied", async () => {
		stubFetch(() => {
			throw new Error("offline");
		});
		const theme = Theme.resume("https://t.example.com/a.css", data({ css: "body{}" }), unloads);
		await theme.reload();
		expect(theme.data.enabled).toBe(false);
		expect(styleFor("https://t.example.com/a.css")).toBeNull();
	});

	test("refuses css over the size limit without touching what is applied", async () => {
		stubFetch(() => reply("a".repeat(Theme.maxCssBytes + 1)));
		const theme = Theme.resume("https://t.example.com/a.css", data({ css: "body{}" }), unloads);
		await theme.reload();
		expect(theme.data.css).toBe("body{}");
		expect(theme.data.enabled).toBe(false);
	});
});

describe("Theme.revalidate", () => {
	const theme = (css = "body{color:red}") => Theme.resume("https://t.example.com/a.css", data({ css }), unloads);

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
		stubFetch(() => reply("a".repeat(Theme.maxCssBytes + 1)));
		const target = theme();
		expect(await target.revalidate()).toBe("failed");
		expect(target.data.css).toBe("body{color:red}");
	});

	test("refuses a record over the limit without fetching it", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const target = theme();
		// What importing a settings backup can leave behind, which never went through the install box
		target.data.css = "a".repeat(Theme.maxCssBytes + 1);
		expect(await target.revalidate()).toBe("failed");
		expect(fetch).not.toHaveBeenCalled();
	});

	test("does not ask about a theme that is off", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const target = Theme.resume("https://t.example.com/a.css", data({ enabled: false, css: "body{}" }), unloads);
		expect(await target.revalidate()).toBe("unchanged");
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("Theme.refreshAll", () => {
	test("checks every enabled theme, including each package of a multi-part theme", async () => {
		stubFetch(() => reply("updated"));
		const base = Theme.resume("https://t.example.com/base.css", data({ css: "base" }), unloads);
		const part2 = Theme.resume("https://t.example.com/part2.css", data({ css: "part2" }), unloads);
		const fonts = Theme.resume("https://t.example.com/fonts.css", data({ css: "fonts" }), unloads);
		const addon = Theme.resume("https://t.example.com/addon.css", data({ enabled: false, css: "addon" }), unloads);

		const summary = await Theme.refreshAll();
		expect(summary.checked).toBe(3);
		expect(summary.updated).toEqual([base, part2, fonts]);
		expect(summary.unchanged).toBe(0);
		expect(summary.failed).toEqual([]);
		// The disabled one is untouched
		expect(addon.data.css).toBe("addon");
		expect(styleFor("https://t.example.com/addon.css")).toBeNull();
	});

	test("counts failures without stopping the others", async () => {
		stubFetch((url) => {
			if (url.includes("a.css")) throw new Error("offline");
			return reply("b2");
		});
		const first = Theme.resume("https://t.example.com/a.css", data({ css: "a" }), unloads);
		const second = Theme.resume("https://t.example.com/b.css", data({ css: "b" }), unloads);

		const summary = await Theme.refreshAll();
		expect(summary.checked).toBe(2);
		expect(summary.updated).toEqual([second]);
		expect(summary.failed).toEqual([first]);
		expect(second.data.css).toBe("b2");
	});

	test("counts unchanged themes without restyling them", async () => {
		stubFetch(() => reply("same"));
		Theme.resume("https://t.example.com/a.css", data({ css: "same" }), unloads);
		Theme.resume("https://t.example.com/b.css", data({ css: "same" }), unloads);

		const summary = await Theme.refreshAll();
		expect(summary).toMatchObject({ checked: 2, unchanged: 2, updated: [], failed: [] });
	});

	test("with no themes installed does nothing", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		expect(await Theme.refreshAll()).toEqual({ checked: 0, unchanged: 0, updated: [], failed: [] });
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("what a row shows", () => {
	test("parses the manifest once and keeps it until the css changes", () => {
		const css = `/* {"name":"cotton candy","author":"Aya"} */\nbody{}`;
		const theme = Theme.resume("https://t.example.com/base-windows.css", data({ css }), unloads);
		expect(theme.manifest).toBe(theme.manifest);
		expect(theme.manifest).toMatchObject({ name: "cotton candy", author: "Aya", source: "t.example.com/base-windows.css" });
	});

	test("falls back to the file name and the repo owner when there is no manifest", () => {
		const theme = Theme.resume(
			"https://raw.githubusercontent.com/aya-zzz-zzz/cottoncandynights/refs/heads/main/fonts/techroundpack.css",
			data({ css: "@font-face { src: url(https://x.test/a.woff2); }" }),
			unloads,
		);
		expect(theme.manifest).toMatchObject({
			name: "Techroundpack",
			author: "aya-zzz-zzz",
			source: "raw.githubusercontent.com/techroundpack.css",
			codeUrl: "https://github.com/aya-zzz-zzz/cottoncandynights/blob/main/fonts/techroundpack.css",
		});
		expect(theme.kind).toBe("Fonts");
	});

	test("reads what the theme loads once", () => {
		const css = "@font-face { src: url(https://github.com/o/r/raw/main/f.woff2); }";
		const theme = Theme.resume("https://t.example.com/a.css", data({ css }), unloads);
		expect(theme.resources).toBe(theme.resources);
		expect(theme.resources.describe()).toBe("loads 1 file, 1 font, from github.com");
	});

	test("re-reads them after a reload, since the file may have changed", async () => {
		stubFetch(() => reply("@font-face { src: url(https://github.com/o/r/raw/main/f.woff2); }"));
		const theme = Theme.resume("https://t.example.com/a.css", data({ css: "body{}" }), unloads);
		expect(theme.resources.describe()).toBeUndefined();
		await theme.reload();
		expect(theme.resources.describe()).toBe("loads 1 file, 1 font, from github.com");
	});

	test("reads nothing out of a theme that has no css yet", () => {
		const theme = Theme.resume("https://t.example.com/a.css", data({ enabled: false }), unloads);
		expect(theme.resources.describe()).toBeUndefined();
		expect(theme.resources.remote).toEqual([]);
		expect(theme.kind).toBe("Theme");
		expect(theme.manifest.name).toBe("A");
	});
});

describe("Theme.check", () => {
	test("says nothing for a theme that loads no files", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await Theme.resume("https://t.example.com/a.css", data({ css: "body{}" }), unloads).check();
		expect(fetch).not.toHaveBeenCalled();
	});

	test("reports progress on the row and clears it afterwards", async () => {
		const seen: { done: number; total: number }[] = [];
		const theme = Theme.resume("https://t.example.com/a.css", data({ css: "@font-face { src: url(https://a.test/x.woff2); }" }), unloads);
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
});

describe("Theme.remove", () => {
	test("takes the css off the page and forgets the theme", () => {
		const theme = Theme.resume("https://t.example.com/a.css", data({ css: "body{}" }), unloads);
		theme.remove();
		expect(styleFor("https://t.example.com/a.css")).toBeNull();
		expect(Theme.get("https://t.example.com/a.css")).toBeUndefined();
		expect(Theme.all()).toEqual([]);
	});
});
