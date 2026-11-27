/**
 * Keeping installed themes up to date.
 *
 * A theme's CSS is stored when it is installed, and the startup path in `Storage.tsx` re-applies that stored CSS
 * without asking the server, so a theme that changed upstream stayed stale until the user refreshed, disabled and
 * re-enabled it (or pressed "Reload theme" once per theme). Themes that ship as several packages - a base, a second
 * part, fonts, addons - made that worse: every one of them had to be refreshed by hand.
 *
 * This module revalidates every enabled theme once, when the app starts: it keeps using the stored CSS if the server
 * says it is unchanged (304), and swaps in the new CSS if it changed. Nothing here imports React or MUI, so it can be
 * tested directly, and the network and the destination are injected rather than reached for, so a test can drive both.
 */

/** What a stored theme keeps beyond its enabled flag. Etag/Last-Modified make the startup check a 304 instead of a download. */
export type ThemeCache = {
	enabled: boolean;
	css?: string;
	etag?: string;
	lastModified?: string;
};

/** The subset of StyleTag this module needs. Injected so tests need no DOM. */
export type CssSink = { css: string | undefined };

/** Upper bound on a theme's CSS. A stylesheet is a few hundred KB at most; anything past this is a mistake or abuse. */
export const maxThemeCssBytes = 2 * 1024 * 1024;

export type RefreshSummary = {
	/** Enabled themes the server was asked about */
	checked: number;
	/** Themes whose CSS changed, and which were re-applied */
	updated: number;
	/** Themes whose CSS was unchanged (304, or the same bytes) */
	unchanged: number;
	/** Themes that could not be revalidated; their stored CSS stays in place */
	failed: { url: string; error: string }[];
	/** The urls whose CSS changed, in the order they were checked, so the change can be named rather than counted */
	updatedUrls: string[];
};

/**
 * Why a theme URL is not acceptable, or undefined when it is.
 *
 * A theme is remote CSS injected into TIDAL's own page: it can restyle the login form, hide a prompt, or fetch from
 * anywhere through `url()`. That makes plain `http` a way for anyone on the network to rewrite the UI, so only `https`
 * is accepted. Plain `http` stays available for a loopback host, which is how a theme is developed and tested locally.
 */
export const themeUrlError = (raw: string): string | undefined => {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return "not a URL";
	}
	const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return "themes must be served over https";
	if (!url.pathname.toLowerCase().endsWith(".css")) return "the url must point at a .css file";
	return undefined;
};

/**
 * The url to fetch a theme from, converting a github page url to the file behind it.
 *
 * `github.com/<owner>/<repo>/blob/<ref>/<path>.css` is the page a browser shows for a file: it ends in `.css` but serves
 * HTML. The file itself is served from `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>.css`. Pasting the page url
 * is the obvious thing to do, so it is converted rather than rejected, and `/raw/` links (what the blob page's Raw
 * button gives) are converted the same way.
 *
 * Anything that is not a github page url is returned unchanged.
 */
export const toRawThemeUrl = (raw: string): string => {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return raw.trim();
	}
	if (url.hostname !== "github.com") return url.href;

	// /<owner>/<repo>/(blob|raw)/<ref>/<path>
	// pathname has a leading slash, so filtering empties gives [owner, repo, blob|raw, ref, ...path]
	const segments = url.pathname.split("/").filter(Boolean);
	const [owner, repo, kind] = segments;
	if (owner === undefined || repo === undefined || (kind !== "blob" && kind !== "raw")) return url.href;
	const rest = segments.slice(3).join("/");
	if (rest === "") return url.href;
	return `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`;
};

/**
 * A theme URL that passes {@link themeUrlError}, or undefined. Query string and hash are kept: they are how a host
 * cache-busts or versions a stylesheet, and refusing them was why `theme.css?v=2` could not be installed at all.
 *
 * A github page url is converted to the raw file first, so what comes back is always something fetchable as css.
 */
export const parseThemeUrl = (raw: string): string | undefined => {
	const trimmed = raw.trim();
	if (trimmed === "") return undefined;
	const url = toRawThemeUrl(trimmed);
	if (themeUrlError(url) !== undefined) return undefined;
	return new URL(url).href;
};

/**
 * What the stored CSS is, for the apply path: undefined when it is usable, otherwise why it is not.
 *
 * `themeUrlError` only guards the install box, but themes are also written wholesale by importing a settings backup or
 * a `luna-settings.json` seed, which never passes through it. This is the check every apply has to make, so a stored
 * `file:` url or a stylesheet over the limit is refused wherever it came from.
 */
export const storedThemeError = (url: string, theme: { css?: string }): string | undefined => {
	// The install path converts a github page url to the file, so a stored one means it arrived from an imported backup.
	// Fetching it would store an HTML page as css, so it is refused rather than silently normalised mid-startup.
	if (toRawThemeUrl(url) !== url) return "stored url is a github page, not the file behind it";
	const urlError = themeUrlError(url);
	if (urlError !== undefined) return urlError;
	if (theme.css !== undefined && theme.css.length > maxThemeCssBytes) return `stored css is ${theme.css.length} bytes, over the limit`;
	return undefined;
};

/** The response the refresh needs, so a test can hand one over without a server */
export type ThemeResponse = {
	status: number;
	ok: boolean;
	text: () => Promise<string>;
	headers: { get: (name: string) => string | null };
};

export type RefreshDeps = {
	fetch: (url: string, init?: { headers?: Record<string, string>; cache?: RequestCache }) => Promise<ThemeResponse>;
	/** Log a theme that was updated or that failed, so the console says what the startup check did */
	log?: (message: string, ...rest: unknown[]) => void;
	error?: (message: string, ...rest: unknown[]) => void;
};

/**
 * Revalidate one theme's CSS, updating `theme` and `sink` when it changed.
 *
 * Returns what happened. On any failure the stored CSS is left alone: a theme that cannot be reached must keep working
 * exactly as it did, rather than disappear because the network was down at startup.
 */
export const revalidateTheme = async (
	url: string,
	theme: ThemeCache,
	sink: CssSink | undefined,
	deps: RefreshDeps,
): Promise<"updated" | "unchanged" | "failed"> => {
	if (!theme.enabled) return "unchanged";
	// A stored url that should never have been written (an imported backup, an older build) is left alone, not fetched
	const storedError = storedThemeError(url, theme);
	if (storedError !== undefined) {
		deps.error?.(`[Themes] Not checking ${url}: ${storedError}`);
		return "failed";
	}

	const headers: Record<string, string> = {};
	// Only when we have something to compare against; a first-but-enabled theme (installed then reload) just downloads
	if (theme.css !== undefined && theme.etag) headers["If-None-Match"] = theme.etag;
	if (theme.css !== undefined && theme.lastModified) headers["If-Modified-Since"] = theme.lastModified;

	try {
		const res = await deps.fetch(url, { headers, cache: "no-cache" });
		if (res.status === 304) return "unchanged";
		if (!res.ok) throw new Error(`HTTP ${res.status}`);

		const css = await res.text();
		if (css.length > maxThemeCssBytes) throw new Error(`CSS is ${css.length} bytes, over the ${maxThemeCssBytes} limit`);
		if (css === theme.css) {
			// Same bytes with no 304: remember the validators so the next start can get a 304
			theme.etag = res.headers.get("etag") ?? theme.etag;
			theme.lastModified = res.headers.get("last-modified") ?? theme.lastModified;
			return "unchanged";
		}

		theme.css = css;
		theme.etag = res.headers.get("etag") ?? undefined;
		theme.lastModified = res.headers.get("last-modified") ?? undefined;
		if (sink) sink.css = css;
		deps.log?.("[Themes] Updated", url);
		return "updated";
	} catch (e) {
		deps.error?.(`[Themes] Could not check for an update: ${url}`, e);
		return "failed";
	}
};

/**
 * Revalidate every enabled theme. Runs after the stored CSS has already been applied, so the page is styled while this
 * is in flight and only changes for the themes that actually changed upstream.
 */
export const revalidateThemes = async (
	themes: Record<string, ThemeCache>,
	sinks: Record<string, CssSink | undefined>,
	deps: RefreshDeps,
): Promise<RefreshSummary> => {
	const summary: RefreshSummary = { checked: 0, updated: 0, unchanged: 0, failed: [], updatedUrls: [] };
	const enabled = Object.entries(themes).filter(([, theme]) => theme.enabled);

	// In parallel: these are independent, and a startup check should not take one round trip per theme
	const results = await Promise.all(
		enabled.map(async ([url, theme]) => {
			const result = await revalidateTheme(url, theme, sinks[url], deps);
			return { url, result };
		}),
	);

	for (const { url, result } of results) {
		summary.checked++;
		if (result === "updated") {
			summary.updated++;
			summary.updatedUrls.push(url);
		} else if (result === "unchanged") summary.unchanged++;
		else summary.failed.push({ url, error: "see console" });
	}
	if (summary.updated > 0) deps.log?.(`[Themes] Refreshed ${summary.updated} of ${summary.checked} theme(s) at startup`);
	return summary;
};

/**
 * An installed theme whose css is the same as `css`, if there is one.
 *
 * The same file is reachable by more than one url: this theme's base is served at both
 * `…/refs/heads/main/base-windows.css` and `…/main/base-windows.css`, so pasting a github page url for a file that was
 * installed from its raw url added a second entry with identical content. Both were applied, so the same 158KB of css
 * loaded twice, and the tab showed two rows for one file.
 *
 * Comparing content catches that whatever the url, including a fork serving the same file.
 */
export const findDuplicateTheme = (themes: Record<string, { css?: string }>, url: string, css: string): string | undefined => {
	const trimmed = css.trim();
	return Object.entries(themes).find(([otherUrl, theme]) => otherUrl !== url && theme.css?.trim() === trimmed)?.[0];
};

/**
 * The toast shown when startup found themes that had changed upstream, or undefined when nothing changed.
 *
 * Themes used to go stale silently: the revalidated CSS was swapped in while TIDAL was starting, so text reflowed and
 * colours shifted with nothing to explain why. Naming the themes makes that readable, and says it happened at startup
 * rather than in response to something the user just did.
 *
 * Names come from the url rather than the manifest: this runs before the UI has parsed the css, and a name is enough.
 */
export const startupUpdateMessage = (
	summary: { updated: number; updatedUrls: string[] },
	nameOf: (url: string) => string,
): string | undefined => {
	if (summary.updated <= 0) return undefined;
	const names = summary.updatedUrls.map(nameOf);
	const listed = names.slice(0, 3).join(", ");
	const rest = names.length - 3;
	const which = rest > 0 ? `${listed} and ${rest} more` : listed;
	return summary.updated === 1 ? `Theme updated at startup: ${which}` : `${summary.updated} themes updated at startup: ${which}`;
};
