import { describe, expect, test, vi } from "vitest";

import type { RefreshDeps, ThemeCache, ThemeResponse } from "./themesRefresh";
import {
	findDuplicateTheme,
	maxThemeCssBytes,
	parseThemeUrl,
	revalidateThemes,
	revalidateTheme,
	startupUpdateMessage,
	storedThemeError,
	themeUrlError,
	toRawThemeUrl,
} from "./themesRefresh";

const response = (body: string, init: { status?: number; etag?: string; lastModified?: string } = {}): ThemeResponse => ({
	status: init.status ?? 200,
	ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
	text: async () => body,
	headers: {
		get: (name: string) => {
			if (name.toLowerCase() === "etag") return init.etag ?? null;
			if (name.toLowerCase() === "last-modified") return init.lastModified ?? null;
			return null;
		},
	},
});

const deps = (fetch: RefreshDeps["fetch"]): RefreshDeps => ({ fetch, log: vi.fn(), error: vi.fn() });

const theme = (over: Partial<ThemeCache> = {}): ThemeCache => ({ enabled: true, css: "body{color:red}", ...over });

describe("themeUrlError", () => {
	test("accepts an https css file", () => {
		expect(themeUrlError("https://themes.example.com/base.css")).toBeUndefined();
	});

	test("refuses plain http, because a theme restyles TIDAL's own page", () => {
		expect(themeUrlError("http://themes.example.com/base.css")).toBe("themes must be served over https");
	});

	test("allows http on loopback, which is how a theme is developed", () => {
		expect(themeUrlError("http://localhost:3000/theme.css")).toBeUndefined();
		expect(themeUrlError("http://127.0.0.1:3000/theme.css")).toBeUndefined();
	});

	test("refuses a file url, which would read a local file into the page", () => {
		expect(themeUrlError("file:///C:/Windows/System32/drivers/etc/hosts.css")).toBe("themes must be served over https");
	});

	test("refuses other schemes", () => {
		expect(themeUrlError("data:text/css,body{color:red}")).toBe("themes must be served over https");
		expect(themeUrlError("ftp://example.com/theme.css")).toBe("themes must be served over https");
	});

	test("refuses a url that is not a css file", () => {
		expect(themeUrlError("https://themes.example.com/theme.js")).toBe("the url must point at a .css file");
		expect(themeUrlError("https://themes.example.com/theme")).toBe("the url must point at a .css file");
	});

	test("refuses something that is not a url at all", () => {
		expect(themeUrlError("not a url")).toBe("not a URL");
	});
});

describe("parseThemeUrl", () => {
	test("keeps a query string, which is how a host versions a stylesheet", () => {
		// This is the url that could not be installed before: it did not end in ".css"
		expect(parseThemeUrl("https://themes.example.com/base.css?v=4")).toBe("https://themes.example.com/base.css?v=4");
	});

	test("trims surrounding whitespace", () => {
		expect(parseThemeUrl("  https://themes.example.com/base.css  ")).toBe("https://themes.example.com/base.css");
	});

	test("is empty for a rejected url", () => {
		expect(parseThemeUrl("http://themes.example.com/base.css")).toBeUndefined();
		expect(parseThemeUrl("   ")).toBeUndefined();
	});

	test("matches the css extension case-insensitively", () => {
		expect(parseThemeUrl("https://themes.example.com/BASE.CSS")).toBe("https://themes.example.com/BASE.CSS");
	});
});

describe("themes that exist in the wild", () => {
	// CottonCandyNights / cotton-candy-colorways ship as a base plus a colorway, which is the multi-part shape that made
	// per-theme manual reloading painful
	const base = "https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/base-windows.css";
	const colorway = "https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/cottoncandy.css";

	test("accepts the real base and cotton candy colorway", () => {
		expect(parseThemeUrl(base)).toBe(base);
		expect(parseThemeUrl(colorway)).toBe(colorway);
	});

	test("accepts the same url with a cache-busting query, which the old suffix check rejected", () => {
		const busted = `${base}?v=${Date.now()}`;
		expect(themeUrlError(busted)).toBeUndefined();
		// The old rule tested the whole url string, so anything with a query fell through to the plugin branch instead
		expect(busted.endsWith(".css")).toBe(false);
		expect(new URL(busted).pathname.endsWith(".css")).toBe(true);
	});

	test("a pasted github page url installs the raw file", () => {
		expect(parseThemeUrl("https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/cottoncandy.css")).toBe(
			"https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/main/cottoncandy.css",
		);
	});

	test("rejects the same theme served over plain http", () => {
		expect(themeUrlError(base.replace("https:", "http:"))).toBe("themes must be served over https");
	});

	test("a github page url is accepted, because it is converted to the file behind it", () => {
		// Pasting the page you copied the link from is the obvious thing to do, and that page ends in .css
		const blob = "https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/base-windows.css";
		expect(themeUrlError(blob)).toBeUndefined();
	});
});

describe("toRawThemeUrl", () => {
	// A theme is shared as a file in a repo, and the link people copy is the page, not the file
	test("converts a blob url to the raw file", () => {
		expect(toRawThemeUrl("https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/base-windows.css")).toBe(
			"https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/main/base-windows.css",
		);
	});

	test("converts the /raw/ link the Raw button gives", () => {
		expect(toRawThemeUrl("https://github.com/aya-zzz-zzz/cottoncandynights/raw/refs/heads/main/fonts/techroundpack.css")).toBe(
			"https://raw.githubusercontent.com/aya-zzz-zzz/cottoncandynights/refs/heads/main/fonts/techroundpack.css",
		);
	});

	test("keeps a nested path intact", () => {
		expect(toRawThemeUrl("https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/pride%20collection/sourrainbowstrips.css")).toBe(
			"https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/main/pride%20collection/sourrainbowstrips.css",
		);
	});

	test("leaves an already raw url alone", () => {
		const raw = "https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/base-windows.css";
		expect(toRawThemeUrl(raw)).toBe(raw);
	});

	test("leaves any other host alone", () => {
		expect(toRawThemeUrl("https://tidaluna.dev/nightwave.css")).toBe("https://tidaluna.dev/nightwave.css");
	});

	test("leaves a github url that is not a file page alone, so the error still explains it", () => {
		const repo = "https://github.com/aya-zzz-zzz/cotton-candy-colorways";
		expect(toRawThemeUrl(repo)).toBe(repo);
		expect(parseThemeUrl(repo)).toBeUndefined();
	});
});

describe("findDuplicateTheme", () => {
	const refsUrl = "https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/base-windows.css";
	const shortUrl = "https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/main/base-windows.css";

	test("finds the same css under a different url", () => {
		// The same file is served at both of these, so installing one after the other applied 158KB of css twice
		const themes = { [refsUrl]: { css: "body{color:red}" } };
		expect(findDuplicateTheme(themes, shortUrl, "body{color:red}")).toBe(refsUrl);
	});

	test("ignores surrounding whitespace, which differs between fetches", () => {
		const themes = { [refsUrl]: { css: "\n body{color:red}\n" } };
		expect(findDuplicateTheme(themes, shortUrl, "body{color:red}\n")).toBe(refsUrl);
	});

	test("does not treat the same url as a duplicate of itself", () => {
		const themes = { [refsUrl]: { css: "body{color:red}" } };
		expect(findDuplicateTheme(themes, refsUrl, "body{color:red}")).toBeUndefined();
	});

	test("does not call different css a duplicate", () => {
		const themes = { [refsUrl]: { css: "body{color:red}" } };
		expect(findDuplicateTheme(themes, shortUrl, "body{color:blue}")).toBeUndefined();
	});

	test("ignores a theme whose css has not loaded yet", () => {
		const themes = { [refsUrl]: {} };
		expect(findDuplicateTheme(themes, shortUrl, "body{color:red}")).toBeUndefined();
	});

	test("is undefined with nothing installed", () => {
		expect(findDuplicateTheme({}, shortUrl, "body{}")).toBeUndefined();
	});
});

describe("storedThemeError", () => {
	// A theme can be written by importing a settings backup or a luna-settings.json seed, neither of which goes through
	// the install box, so the check has to exist on the apply path too
	test("accepts a stored https css theme", () => {
		expect(storedThemeError("https://t.example.com/a.css", { css: "body{}" })).toBeUndefined();
	});

	test("refuses a stored url that the install box would refuse", () => {
		expect(storedThemeError("data:text/css,body{}//x.css", {})).toBe("themes must be served over https");
		expect(storedThemeError("file:///C:/x.css", {})).toBe("themes must be served over https");
		expect(storedThemeError("https://t.example.com/a.js", {})).toBe("the url must point at a .css file");
	});

	test("refuses a stored github page url, which would store html as css", () => {
		expect(storedThemeError("https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/base-windows.css", {})).toBe(
			"stored url is a github page, not the file behind it",
		);
	});

	test("refuses stored css over the limit, whatever its url", () => {
		expect(storedThemeError("https://t.example.com/a.css", { css: "a".repeat(maxThemeCssBytes + 1) })).toContain("over the limit");
	});
});

describe("revalidateTheme", () => {
	test("sends the stored validators so an unchanged theme costs a 304", async () => {
		const fetch = vi.fn<RefreshDeps["fetch"]>(async () => response("", { status: 304 }));
		const sink = { css: "old" } as { css: string | undefined };
		const result = await revalidateTheme(
			"https://t.example.com/a.css",
			theme({ etag: '"abc"', lastModified: "Wed, 21 Oct 2015 07:28:00 GMT" }),
			sink,
			deps(fetch),
		);

		expect(result).toBe("unchanged");
		expect(fetch).toHaveBeenCalledOnce();
		const [, init] = fetch.mock.calls[0];
		expect(init?.headers?.["If-None-Match"]).toBe('"abc"');
		expect(init?.headers?.["If-Modified-Since"]).toBe("Wed, 21 Oct 2015 07:28:00 GMT");
		// Nothing is restyled when the server says nothing changed
		expect(sink.css).toBe("old");
	});

	test("applies changed css and remembers the new validators", async () => {
		const sink = { css: "old" } as { css: string | undefined };
		const target = theme({ etag: '"old"' });
		const result = await revalidateTheme(
			"https://t.example.com/a.css",
			target,
			sink,
			deps(async () => response("body{color:blue}", { etag: '"new"', lastModified: "Thu, 22 Oct 2015 07:28:00 GMT" })),
		);

		expect(result).toBe("updated");
		expect(target.css).toBe("body{color:blue}");
		expect(sink.css).toBe("body{color:blue}");
		expect(target.etag).toBe('"new"');
		expect(target.lastModified).toBe("Thu, 22 Oct 2015 07:28:00 GMT");
	});

	test("trims nothing and compares exactly: the same bytes are not a change", async () => {
		const sink = { css: "old" } as { css: string | undefined };
		const result = await revalidateTheme(
			"https://t.example.com/a.css",
			theme(),
			sink,
			deps(async () => response("body{color:red}")),
		);

		expect(result).toBe("unchanged");
		expect(sink.css).toBe("old");
	});

	test("keeps the stored css when the request fails, so a theme never disappears because the network was down", async () => {
		const sink = { css: "old" } as { css: string | undefined };
		const target = theme();
		const d = deps(async () => {
			throw new Error("offline");
		});
		const result = await revalidateTheme("https://t.example.com/a.css", target, sink, d);

		expect(result).toBe("failed");
		expect(target.css).toBe("body{color:red}");
		expect(sink.css).toBe("old");
		expect(d.error).toHaveBeenCalledOnce();
	});

	test("keeps the stored css on a non-ok status", async () => {
		const sink = { css: "old" } as { css: string | undefined };
		const result = await revalidateTheme(
			"https://t.example.com/a.css",
			theme(),
			sink,
			deps(async () => response("gone", { status: 404 })),
		);

		expect(result).toBe("failed");
		expect(sink.css).toBe("old");
	});

	test("refuses css over the size limit", async () => {
		const sink = { css: "old" } as { css: string | undefined };
		const target = theme();
		const result = await revalidateTheme(
			"https://t.example.com/a.css",
			target,
			sink,
			deps(async () => response("a".repeat(maxThemeCssBytes + 1))),
		);

		expect(result).toBe("failed");
		expect(sink.css).toBe("old");
		expect(target.css).toBe("body{color:red}");
	});

	test("refuses a stored url that should never have been written, without fetching it", async () => {
		const fetch = vi.fn<RefreshDeps["fetch"]>(async () => response("x"));
		const d = deps(fetch);
		const result = await revalidateTheme("data:text/css,body{}//x.css", theme(), undefined, d);

		expect(result).toBe("failed");
		expect(fetch).not.toHaveBeenCalled();
		expect(d.error).toHaveBeenCalledOnce();
	});

	test("does not ask about a disabled theme", async () => {
		const fetch = vi.fn(async () => response("body{}"));
		const result = await revalidateTheme("https://t.example.com/a.css", theme({ enabled: false }), undefined, deps(fetch));

		expect(result).toBe("unchanged");
		expect(fetch).not.toHaveBeenCalled();
	});

	test("works with no sink: a theme can be revalidated before its StyleTag exists", async () => {
		const target = theme();
		const result = await revalidateTheme(
			"https://t.example.com/a.css",
			target,
			undefined,
			deps(async () => response("new{}")),
		);

		expect(result).toBe("updated");
		expect(target.css).toBe("new{}");
	});

	test("downloads when an enabled theme has no css yet", async () => {
		const target: ThemeCache = { enabled: true };
		const fetch = vi.fn<RefreshDeps["fetch"]>(async () => response("first{}"));
		const result = await revalidateTheme("https://t.example.com/a.css", target, undefined, deps(fetch));

		expect(result).toBe("updated");
		expect(target.css).toBe("first{}");
		// No validators stored, so nothing to send
		expect(fetch.mock.calls[0][1]?.headers).toEqual({});
	});
});

describe("revalidateThemes", () => {
	test("checks every enabled theme, including each package of a multi-part theme", async () => {
		const themes: Record<string, ThemeCache> = {
			"https://t.example.com/base.css": { enabled: true, css: "base" },
			"https://t.example.com/part2.css": { enabled: true, css: "part2" },
			"https://t.example.com/fonts.css": { enabled: true, css: "fonts" },
			"https://t.example.com/addon.css": { enabled: false, css: "addon" },
		};
		const sinks = {
			"https://t.example.com/base.css": { css: "base" } as { css: string | undefined },
			"https://t.example.com/part2.css": { css: "part2" } as { css: string | undefined },
			"https://t.example.com/fonts.css": { css: "fonts" } as { css: string | undefined },
		};
		const result = await revalidateThemes(
			themes,
			sinks,
			deps(async () => response("updated")),
		);

		expect(result.checked).toBe(3);
		expect(result.updated).toBe(3);
		expect(sinks["https://t.example.com/base.css"].css).toBe("updated");
		expect(sinks["https://t.example.com/fonts.css"].css).toBe("updated");
		// The disabled one is untouched
		expect(themes["https://t.example.com/addon.css"].css).toBe("addon");
	});

	test("counts failures without stopping the others", async () => {
		const themes: Record<string, ThemeCache> = {
			"https://t.example.com/a.css": { enabled: true, css: "a" },
			"https://t.example.com/b.css": { enabled: true, css: "b" },
		};
		const result = await revalidateThemes(
			themes,
			{},
			{
				fetch: async (url) => {
					if (url.includes("a.css")) throw new Error("offline");
					return response("b2");
				},
				log: vi.fn(),
				error: vi.fn(),
			},
		);

		expect(result.checked).toBe(2);
		expect(result.updated).toBe(1);
		expect(result.failed).toEqual([{ url: "https://t.example.com/a.css", error: "see console" }]);
		expect(themes["https://t.example.com/b.css"].css).toBe("b2");
	});

	test("sums up instead of logging once per unchanged theme", async () => {
		const log = vi.fn();
		const themes: Record<string, ThemeCache> = {
			"https://t.example.com/a.css": { enabled: true, css: "same" },
			"https://t.example.com/b.css": { enabled: true, css: "same" },
		};
		const summary = await revalidateThemes(themes, {}, { fetch: async () => response("same"), log, error: vi.fn() });

		expect(summary.updated).toBe(0);
		expect(summary.unchanged).toBe(2);
		expect(log).not.toHaveBeenCalled();
	});

	test("with no themes installed does nothing", async () => {
		const fetch = vi.fn(async () => response("x"));
		const summary = await revalidateThemes({}, {}, deps(fetch));

		expect(summary).toEqual({ checked: 0, updated: 0, unchanged: 0, failed: [], updatedUrls: [] });
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("startupUpdateMessage", () => {
	const name = (url: string) => url.split("/").pop() ?? url;

	test("says nothing when nothing changed", () => {
		expect(startupUpdateMessage({ updated: 0, updatedUrls: [] }, name)).toBeUndefined();
	});

	test("names a single changed theme", () => {
		expect(startupUpdateMessage({ updated: 1, updatedUrls: ["https://a.test/base-windows.css"] }, name)).toBe(
			"Theme updated at startup: base-windows.css",
		);
	});

	test("counts several and names them", () => {
		const urls = ["https://a.test/one.css", "https://a.test/two.css"];
		expect(startupUpdateMessage({ updated: 2, updatedUrls: urls }, name)).toBe("2 themes updated at startup: one.css, two.css");
	});

	test("shortens a long list rather than filling the toast", () => {
		const urls = ["a.css", "b.css", "c.css", "d.css", "e.css"].map((f) => `https://a.test/${f}`);
		expect(startupUpdateMessage({ updated: 5, updatedUrls: urls }, name)).toBe("5 themes updated at startup: a.css, b.css, c.css and 2 more");
	});
});
