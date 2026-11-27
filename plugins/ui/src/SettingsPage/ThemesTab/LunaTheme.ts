/**
 * An installed theme.
 *
 * A theme is remote CSS applied to TIDAL's own page, so it is a stylesheet with a stored entry beside it, and both have
 * to move together: the row's switch, the page's styles and what survives a restart are the same theme seen three ways.
 * That is why this is a class: the url rules, the stored entry, the applied stylesheet, the parsed manifest and the files
 * it loads are one object, and installing, enabling, reloading and revalidating are one place to look.
 *
 * Nothing here touches the settings UI: the stored record is passed in, so a theme can be installed against a test object
 * as easily as against the reactive store.
 */

import { Signal } from "@inrixia/helpers";
import { ftch, type LunaUnloads, Tracer } from "@luna/core";
import { GitUrl, StyleTag } from "@luna/lib";

import { themeConsent, type ThemeConsent } from "./ThemeConsent";
import { ThemeManifest } from "./ThemeManifest";
import { ThemeResources } from "./ThemeResources";

const { trace } = Tracer("[@luna/ui]", null);

/** What a stored theme keeps beyond its enabled flag. The css is stored so a restart restyles the page without a request. */
export type ThemeData = {
	enabled: boolean;
	css?: string;
};

/** What a refresh found, for the tab and the toast to report */
export type RefreshSummary = {
	/** Enabled themes the server was asked about */
	checked: number;
	/** Themes whose css was unchanged */
	unchanged: number;
	/** Themes whose css changed, and which were re-applied */
	updated: LunaTheme[];
	/** Themes that could not be revalidated; their stored css stays in place */
	failed: LunaTheme[];
};

/** Asks the user whether a theme that downloads files may be installed */
export type ThemeConsentFn = (consent: ThemeConsent) => Promise<boolean>;

/**
 * How far the check of a theme's files has got, so the row can show it instead of going silent.
 *
 * Checking used to stop after twenty files, which meant a theme could put harmless files first and never have the rest
 * looked at. Now every file is checked, which is why the work needs to be visible while it runs.
 */
export const resourceProgress = new Signal<Record<string, { done: number; total: number }>>({});

/** Upper bound on a theme's css. A stylesheet is a few hundred KB at most; anything past this is a mistake or abuse. */
const cssLimit = 2 * 1024 * 1024;

/**
 * The url to fetch a theme from, converting a page url to the file behind it.
 *
 * `github.com/<owner>/<repo>/blob/<ref>/<path>.css` is the page a browser shows for a file: it ends in `.css` but serves
 * HTML. The file itself is served from elsewhere (`raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>.css` on github,
 * `/-/raw/…` on gitlab, `/raw/branch/…` on gitea), which is what GitUrl converts to. Pasting the page url is the obvious
 * thing to do, so it is converted rather than rejected.
 *
 * Anything that is not a file in a repository is left exactly as it is: a theme served from a plain host has no page to
 * convert, and a repository or folder url names no file.
 */
export const themeUrlOf = (raw: string): string => GitUrl.from(raw)?.rawUrl ?? raw;

/** The url, normalised, or an Error saying why a theme cannot be fetched from it */
const validateUrl = (url: string): string => {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("That is not a url");
	}
	// A theme restyles TIDAL's own page: it can hide a prompt or fetch from anywhere through `url()`, so plain http would let
	// anyone on the network rewrite the UI. Loopback stays, because that is how a theme is developed locally
	const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new Error("A theme must be served over https");
	if (!parsed.pathname.toLowerCase().endsWith(".css")) throw new Error("A theme url must point at a .css file");
	return parsed.href;
};

/**
 * Judge css that came from a url, throwing when it is not a stylesheet of a sane size.
 *
 * A theme is stored as css and re-applied on every start, so a url that answers with a web page, json, an error body or
 * nothing at all is refused before it is stored: stored, it restyles nothing and looks installed.
 */
const assertThemeCss = (css: string): void => {
	if (css.length > cssLimit) throw new Error(`That theme's css is ${css.length} bytes, over the ${cssLimit} limit`);
	// An error page is the common case: github serves HTML for a missing raw file, and for every /blob/ page
	const start = css.trimStart().slice(0, 200).toLowerCase();
	if (start.startsWith("<!doctype html") || start.startsWith("<html")) throw new Error("That url returned a web page, not a stylesheet");
	if (start.startsWith("<?xml") && start.includes("<html")) throw new Error("That url returned a web page, not a stylesheet");
	if (start.startsWith("{") || start.startsWith("[")) throw new Error("That url returned json, not a stylesheet");
	if (start.startsWith("404:") || start.startsWith("not found")) throw new Error("That url returned an error, not a stylesheet");
	// A stylesheet has at least one rule or an at-rule; an empty body restyles nothing
	if (css.trim() === "") throw new Error("That url returned an empty body");
	if (!css.includes("{") && !css.includes("@")) throw new Error("That url does not look like css");
};

/**
 * Throw when a stored url, or the css stored beside it, should never have been written.
 *
 * Themes are also written wholesale by importing a settings backup or a `luna-settings.json` seed, which never see the
 * install box, so this runs when a theme is created rather than only where a url is typed. It runs before the instance
 * exists, so a refused record does not leave a StyleTag and an unload handler behind for a theme that never was.
 */
const validateTheme = (url: string, data: ThemeData): void => {
	// A stored page url arrived from an imported backup. Fetching it would store an HTML page as css
	if (GitUrl.from(url)?.kind === "blob") throw new Error("That theme is stored as a page, not the file behind it");
	validateUrl(url);
	if (data.css !== undefined) assertThemeCss(data.css);
};

export class LunaTheme extends StyleTag {
	/** Upper bound on a theme's css, so a caller can check a length without importing the rule */
	public static readonly maxCssBytes = cssLimit;

	/** Every theme this page knows about, by url. A theme is deduplicated here, so one url is one instance */
	public static readonly themes = new Map<string, LunaTheme>();

	public readonly url: string;
	/** The stored entry this theme writes back to, so what a row shows and what survives a restart are one thing */
	public readonly data: ThemeData;
	/** What the row says about this theme, read from the css it has */
	public manifest: ThemeManifest;
	/** The files it loads, read from the css it has */
	public resources: ThemeResources;

	/** The css with its surrounding whitespace gone, which is what makes two urls serving one file the same theme */
	private cleanCss?: string;

	private constructor(url: string, data: ThemeData, unloads: LunaUnloads) {
		super(url, unloads);
		this.url = url;
		this.data = data;
		this.cleanCss = data.css?.trim();
		this.manifest = ThemeManifest.from(url, data.css);
		this.resources = ThemeResources.from(data.css ?? "", url);
		// The stored css goes on the page without a request. A theme that never finished downloading is fetched by
		// startLoading, once it is registered and its row can report the outcome
		if (data.enabled && data.css !== undefined) this.apply(data.css);
	}

	/**
	 * The theme for a url, created once.
	 *
	 * Deduplicated on the url, which is what makes `LunaTheme.from` the way to take over a stored record: two rows for one
	 * url are one theme, and a second call returns the instance that is already styling the page.
	 */
	static from(url: string, data: ThemeData, unloads: LunaUnloads): LunaTheme {
		const known = LunaTheme.themes.get(url);
		if (known !== undefined) return known;
		validateTheme(url, data);
		const theme = new LunaTheme(url, data, unloads);
		LunaTheme.themes.set(url, theme);
		theme.startLoading();
		return theme;
	}

	/** Fetch a theme that is on but has never been applied, now that it is registered and its row can show the failure */
	private startLoading(): void {
		if (this.data.enabled && this.data.css === undefined) this.reload();
	}

	/**
	 * Take over every theme in a stored record, reporting the entries that could not be.
	 *
	 * An entry that should never have been written is reported and left alone rather than dropped: it still holds the css
	 * that was downloaded, and losing that to a stray field would be worse than the field.
	 */
	static loadFromStore(store: Record<string, ThemeData>, unloads: LunaUnloads, onError: (url: string, error: unknown) => void): void {
		for (const [url, data] of Object.entries(store)) {
			try {
				LunaTheme.from(url, data, unloads);
			} catch (error) {
				onError(url, error);
			}
		}
	}

	/** Every theme this page knows about */
	static all(): LunaTheme[] {
		return [...LunaTheme.themes.values()];
	}

	/** An installed theme whose css is the same as `css`, if there is one */
	static findByCss(css: string, exceptUrl?: string): LunaTheme | undefined {
		const wanted = css.trim();
		for (const theme of LunaTheme.themes.values()) {
			if (theme.url !== exceptUrl && theme.cleanCss === wanted) return theme;
		}
		return undefined;
	}

	/**
	 * Install a theme from a url, without touching the page until every reason to refuse it has been checked.
	 *
	 * The same file is reachable by more than one url: this theme's base is served at both
	 * `…/refs/heads/main/base-windows.css` and `…/main/base-windows.css`, so pasting a github page url for a file that was
	 * installed from its raw url added a second entry with identical content. Both were applied, so the same 158KB of css
	 * loaded twice, and the tab showed two rows for one file. Comparing content catches that whatever the url, including a
	 * fork serving the same file.
	 */
	static async install(rawUrl: string, store: Record<string, ThemeData>, unloads: LunaUnloads, askConsent?: ThemeConsentFn): Promise<LunaTheme> {
		const trimmed = rawUrl.trim();
		if (trimmed === "") throw new Error("That theme url is empty");
		const url = validateUrl(themeUrlOf(trimmed));
		if (LunaTheme.themes.has(url)) throw new Error("That theme is already installed");

		let css: string;
		try {
			css = await ftch.text(url);
		} catch (e) {
			throw new Error(`Could not load that url: ${e instanceof Error ? e.message : String(e)}`);
		}
		assertThemeCss(css);

		const duplicate = LunaTheme.findByCss(css, url);
		if (duplicate !== undefined) throw new Error(`That theme is already installed as ${duplicate.manifest.source}`);

		// A theme is css, but it can name anything to fetch. Installing it is the moment the user is still deciding, so ask
		// before it is stored and applied. Without a handler to ask with, a theme that downloads files is refused
		const consent = themeConsent(ThemeResources.from(css, url), ThemeManifest.from(url, css).name);
		if (consent.required) {
			if (askConsent === undefined) throw new Error("This theme downloads files, and there is no way to ask about that here");
			if (!(await askConsent(consent))) throw new Error("Theme was not installed");
		}

		// Accepted: the record is written only once the theme exists, so a refusal cannot leave a stored entry behind
		const data: ThemeData = { enabled: true, css };
		const theme = LunaTheme.from(url, data, unloads);
		store[url] = data;

		// What the theme loads and whether it is what it claims: one bad file is not a reason to throw away a theme that
		// otherwise works, so it is reported on the row rather than refused
		theme.check().catch(trace.err.withContext(`Could not check what ${url} loads`));
		return theme;
	}

	/**
	 * Revalidate every enabled theme, in parallel, and report what changed.
	 *
	 * Startup is the caller's decision, and so is what to say about it once the answer is known: this does the work and
	 * returns the summary.
	 */
	static async refreshAll(): Promise<RefreshSummary> {
		const summary: RefreshSummary = { checked: 0, unchanged: 0, updated: [], failed: [] };
		await Promise.all(
			LunaTheme.all().map(async (theme) => {
				// A theme that is off is not on the page, so there is nothing to restyle and nothing worth a request
				if (!theme.data.enabled) return;
				summary.checked++;
				const result = await theme.revalidate();
				if (result === "updated") summary.updated.push(theme);
				else if (result === "failed") summary.failed.push(theme);
				else summary.unchanged++;
			}),
		);
		return summary;
	}

	/**
	 * Apply the stored css, fetching it first when the theme has never been applied.
	 *
	 * Does not reject: a fetch that fails turns the theme off and says so through the tracer, so a caller with no error path
	 * of its own is not left holding a rejected promise.
	 */
	async enable(): Promise<void> {
		this.data.enabled = true;
		if (this.data.css === undefined) return this.reload();
		this.apply(this.data.css);
	}

	disable(): void {
		this.data.enabled = false;
		// StyleTag removes its element when its css is cleared, so this is what actually unstyled the page
		this.css = undefined;
	}

	/**
	 * Read the file again, and restyle the page when the theme is on.
	 *
	 * A theme that cannot be fetched is turned off rather than left enabled: an enabled theme with nothing applied is worse
	 * than a disabled one, because the switch says it is on and the page looks unchanged with no way to tell why.
	 */
	async reload(): Promise<void> {
		try {
			const css = await ftch.text(this.url);
			assertThemeCss(css);
			this.apply(css);
		} catch (e) {
			trace.err.withContext(`Could not reload ${this.url}`)(e);
			this.disable();
		}
	}

	/**
	 * Revalidate this theme's css against the server.
	 *
	 * The browser's own http cache does the conditional request: the stored css is compared with what comes back, so a theme
	 * that has not changed costs nothing. On any failure the stored css is left alone, because a theme that cannot be
	 * reached must keep working exactly as it did rather than disappear because the network was down at startup.
	 */
	async revalidate(): Promise<"updated" | "unchanged" | "failed"> {
		// A theme that is off is not on the page, so there is nothing to restyle and nothing worth a request
		if (!this.data.enabled) return "unchanged";
		try {
			// Only the size is checked again: the url rules and the shape of the stylesheet were settled when this was created,
			// and re-reading a stored stylesheet on every start costs a full pass over it for an answer already known
			const stored = this.data.css;
			if (stored !== undefined && stored.length > cssLimit) {
				throw new Error(`That theme has ${stored.length} bytes of css stored, over the ${cssLimit} limit`);
			}
			const response = await fetch(this.url);
			if (response.status === 304) return "unchanged";
			if (!response.ok) throw new Error(`answered HTTP ${response.status}`);
			const css = await response.text();
			assertThemeCss(css);
			if (css === stored) return "unchanged";
			this.apply(css);
			return "updated";
		} catch (e) {
			trace.err.withContext(`Could not check for an update to ${this.url}`)(e);
			return "failed";
		}
	}

	/** Check that every file this theme loads is what its css says it is, throwing on the first that is not */
	async check(): Promise<void> {
		const total = this.resources.remote.length;
		if (total === 0) return;
		try {
			await this.resources.check((done, files) => {
				resourceProgress._ = { ...resourceProgress._, [this.url]: { done, total: files } };
			});
		} finally {
			// The row goes back to its normal line once the check is done, pass or fail
			const next = { ...resourceProgress._ };
			delete next[this.url];
			resourceProgress._ = next;
		}
	}

	/** Uninstall: stop styling the page and forget the theme */
	remove(): void {
		LunaTheme.themes.delete(this.url);
		super.remove();
	}

	/** Put a theme's css in place, storing it so the next start needs no request */
	private apply(css: string): void {
		this.data.css = css;
		this.cleanCss = css.trim();
		this.manifest = ThemeManifest.from(this.url, css);
		this.resources = ThemeResources.from(css, this.url);
		// A disabled theme still stores what it downloaded; only an enabled one is on the page
		if (this.data.enabled) this.css = css;
	}
}
