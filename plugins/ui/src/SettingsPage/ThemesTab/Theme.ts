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
import { StyleTag } from "@luna/lib";

import { ThemeManifest, type ThemeKind } from "./ThemeManifest";
import { ThemeResources, type ResourceFailure, type ThemeConsent } from "./ThemeResources";

const { trace } = Tracer("[@luna/ui]", null);

/** What a stored theme keeps beyond its enabled flag. The css is stored so a restart restyles the page without a request. */
export type ThemeData = {
	enabled: boolean;
	css?: string;
};

/** What a startup refresh found, for the tab and the toast to report */
export type RefreshSummary = {
	/** Enabled themes the server was asked about */
	checked: number;
	/** Themes whose css was unchanged */
	unchanged: number;
	/** Themes whose css changed, and which were re-applied */
	updated: Theme[];
	/** Themes that could not be revalidated; their stored css stays in place */
	failed: Theme[];
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

export class Theme extends StyleTag {
	/** Upper bound on a theme's css. A stylesheet is a few hundred KB at most; anything past this is a mistake or abuse. */
	public static readonly maxCssBytes = 2 * 1024 * 1024;

	/** Every theme this page knows about, by url */
	private static readonly registry = new Map<string, Theme>();

	public readonly url: string;
	/** The stored entry this theme writes back to, so what a row shows and what survives a restart are one thing */
	public readonly data: ThemeData;

	/** Read once per css, since a row and a refresh both ask for them */
	private cachedManifest?: ThemeManifest;
	private cachedResources?: ThemeResources;
	/** The css with its surrounding whitespace gone, which is what makes two urls serving one file the same theme */
	private cleanCss?: string;

	private constructor(url: string, data: ThemeData, unloads: LunaUnloads) {
		super(url, unloads);
		this.url = url;
		this.data = data;
		this.cleanCss = data.css?.trim();
	}

	// #region Url rules. Every url a theme is judged by goes through these three, so they cannot disagree.

	/**
	 * The url to fetch a theme from, converting a github page url to the file behind it.
	 *
	 * `github.com/<owner>/<repo>/blob/<ref>/<path>.css` is the page a browser shows for a file: it ends in `.css` but serves
	 * HTML. The file itself is served from `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>.css`. Pasting the page url
	 * is the obvious thing to do, so it is converted rather than rejected, and `/raw/` links (what the blob page's Raw
	 * button gives) are converted the same way.
	 */
	static rawUrlOf(raw: string): string {
		const path = ThemeManifest.githubPath(raw);
		if (path === undefined || path.host !== "github.com") return raw;
		const [kind] = path.rest;
		if (kind !== "blob" && kind !== "raw") return raw;
		const rest = path.rest.slice(1).join("/");
		if (rest === "") return raw;
		return `https://raw.githubusercontent.com/${path.owner}/${path.repo}/${rest}`;
	}

	/**
	 * The url a theme someone pasted is fetched from, or an Error saying why it cannot be one.
	 *
	 * A theme is remote CSS injected into TIDAL's own page: it can restyle the login form, hide a prompt, or fetch from
	 * anywhere through `url()`. That makes plain `http` a way for anyone on the network to rewrite the UI, so only `https`
	 * is accepted. Plain `http` stays available for a loopback host, which is how a theme is developed and tested locally.
	 */
	static parseUrl(raw: string): string {
		const trimmed = raw.trim();
		if (trimmed === "") throw new Error("That theme url is empty");
		return Theme.validateUrl(Theme.rawUrlOf(trimmed));
	}

	/**
	 * Check a url that is already stored, which never went through {@link parseUrl}.
	 *
	 * Themes are also written wholesale by importing a settings backup or a `luna-settings.json` seed, which never see the
	 * install box. This is the check every apply and every refresh has to make, so a stored `file:` url or a stylesheet over
	 * the limit is refused wherever it came from.
	 */
	static validateStored(url: string, data: ThemeData): void {
		// A stored github page url means it arrived from an imported backup. Fetching it would store an HTML page as css, so
		// it is refused rather than silently normalised mid-startup.
		if (Theme.rawUrlOf(url) !== url) throw new Error("That theme is stored as a github page, not the file behind it");
		Theme.validateUrl(url);
		if (data.css !== undefined && data.css.length > Theme.maxCssBytes) {
			throw new Error(`That theme has ${data.css.length} bytes of css stored, over the ${Theme.maxCssBytes} limit`);
		}
	}

	/** The url, normalised, or an Error saying why a theme cannot be fetched from it */
	private static validateUrl(url: string): string {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error("That is not a url");
		}
		const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
		if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new Error("A theme must be served over https");
		if (!parsed.pathname.toLowerCase().endsWith(".css")) throw new Error("A theme url must point at a .css file");
		return parsed.href;
	}

	// #endregion

	// #region Registry

	/** Every theme this page knows about */
	static all(): Theme[] {
		return [...Theme.registry.values()];
	}

	static get(url: string): Theme | undefined {
		return Theme.registry.get(url);
	}

	/**
	 * Take over a theme that is already stored, applying it when it is enabled.
	 *
	 * Throws when the stored entry should never have been written, which the caller reports and then leaves alone: dropping
	 * a theme because its record is bad would lose the css that is in it.
	 */
	static resume(url: string, data: ThemeData, unloads: LunaUnloads): Theme {
		const known = Theme.registry.get(url);
		if (known !== undefined) return known;
		Theme.validateStored(url, data);
		const theme = new Theme(url, data, unloads);
		Theme.registry.set(url, theme);
		if (data.enabled) void theme.enable();
		return theme;
	}

	/** An installed theme whose css is the same as `css`, if there is one */
	static findByCss(css: string, exceptUrl?: string): Theme | undefined {
		const wanted = css.trim();
		return Theme.all().find((theme) => theme.url !== exceptUrl && theme.cleanCss === wanted);
	}

	// #endregion

	// #region Install and refresh

	/**
	 * Install a theme from a url, without touching the page until every reason to refuse it has been checked.
	 *
	 * The same file is reachable by more than one url: this theme's base is served at both
	 * `…/refs/heads/main/base-windows.css` and `…/main/base-windows.css`, so pasting a github page url for a file that was
	 * installed from its raw url added a second entry with identical content. Both were applied, so the same 158KB of css
	 * loaded twice, and the tab showed two rows for one file. Comparing content catches that whatever the url, including a
	 * fork serving the same file.
	 */
	static async install(rawUrl: string, themes: Record<string, ThemeData>, unloads: LunaUnloads, askConsent?: ThemeConsentFn): Promise<Theme> {
		const url = Theme.parseUrl(rawUrl);
		if (Theme.registry.has(url)) throw new Error("That theme is already installed");

		let css: string;
		try {
			css = await ftch.text(url);
		} catch (e) {
			throw new Error(`Could not load that url: ${e instanceof Error ? e.message : String(e)}`);
		}
		// Uncapped css is persisted and re-applied on every start, so the limit has to be enforced here too
		if (css.length > Theme.maxCssBytes) throw new Error(`That theme's css is ${css.length} bytes, over the ${Theme.maxCssBytes} limit`);
		// A url that answers with a web page or json is not a theme: storing it would apply nothing and look like it worked
		ThemeResources.assertStylesheet(css);
		const duplicate = Theme.findByCss(css, url);
		if (duplicate !== undefined) throw new Error(`That theme is already installed as ${duplicate.manifest.source}`);

		// A theme is css, but it can name anything to fetch: the font pack installs thirteen binaries. Installing it is the
		// moment the user is still deciding, so ask before it is stored and applied. Without a handler to ask with, a theme
		// that downloads files is refused rather than installed unasked.
		const resources = ThemeResources.of(css, url);
		const consent = resources.consent(ThemeManifest.of(url, css).name);
		if (consent.required) {
			if (askConsent === undefined) throw new Error("This theme downloads files, and there is no way to ask about that here");
			if (!(await askConsent(consent))) throw new Error("Theme was not installed");
		}

		// Accepted: only now does the entry exist, with the css already in hand
		const theme = new Theme(url, (themes[url] = { enabled: true }), unloads);
		Theme.registry.set(url, theme);
		theme.apply(css);
		trace.log(`Added and applied theme: ${url}`);

		// What the theme loads and whether it is what it claims: a font url that serves an html page leaves the theme looking
		// broken for a reason nothing on screen explains. Reported rather than refused, since one bad file is not a reason to
		// throw away a theme that otherwise works.
		void theme.check().catch(trace.err.withContext(`Could not check what ${url} loads`));
		return theme;
	}

	/**
	 * Revalidate every enabled theme once, at startup.
	 *
	 * The stored css is applied without asking the server, which is why a theme used to stay stale until it was refreshed by
	 * hand and then disabled and re-enabled (or reloaded one by one, which hurt themes shipped as several packages: a base,
	 * a second part, fonts, addons). This runs after that, so the page is styled while it is in flight and only changes for
	 * the themes that actually changed upstream.
	 */
	static async refreshAll(): Promise<RefreshSummary> {
		const summary: RefreshSummary = { checked: 0, unchanged: 0, updated: [], failed: [] };
		// In parallel: these are independent, and a startup check should not take one round trip per theme
		await Promise.all(
			Theme.all().map(async (theme) => {
				if (!theme.data.enabled) return;
				summary.checked++;
				const result = await theme.revalidate();
				if (result === "updated") summary.updated.push(theme);
				else if (result === "failed") summary.failed.push(theme);
				else summary.unchanged++;
			}),
		);
		if (summary.updated.length > 0) trace.log(`Refreshed ${summary.updated.length} of ${summary.checked} theme(s) at startup`);
		return summary;
	}

	// #endregion

	// #region What a row shows

	/** What the row says about this theme, parsed from its css once */
	get manifest(): ThemeManifest {
		return (this.cachedManifest ??= ThemeManifest.of(this.url, this.data.css));
	}

	/** What this file is: a layout base, a colour palette, or a font pack */
	get kind(): ThemeKind {
		return ThemeManifest.kindOf(this.data.css);
	}

	/** The files this theme loads, read from its css once */
	get resources(): ThemeResources {
		return (this.cachedResources ??= ThemeResources.of(this.data.css ?? "", this.url));
	}

	// #endregion

	// #region Lifecycle

	/** Apply the stored css, fetching it first when the theme has never been applied */
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
			if (css.length > Theme.maxCssBytes) throw new Error(`is ${css.length} bytes, over the ${Theme.maxCssBytes} limit`);
			this.apply(css);
			trace.log(`Loaded theme ${this.url}`);
		} catch (e) {
			trace.err.withContext(`Failed to load theme ${this.url}`)(e);
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
			Theme.validateStored(this.url, this.data);
			const response = await fetch(this.url);
			if (response.status === 304) return "unchanged";
			if (!response.ok) throw new Error(`answered HTTP ${response.status}`);
			const css = await response.text();
			if (css.length > Theme.maxCssBytes) throw new Error(`is ${css.length} bytes, over the ${Theme.maxCssBytes} limit`);
			if (css === this.data.css) return "unchanged";
			this.apply(css);
			trace.log(`Updated theme ${this.url}`);
			return "updated";
		} catch (e) {
			trace.err.withContext(`Could not check for an update to ${this.url}`)(e);
			return "failed";
		}
	}

	/** Check every file this theme loads, reporting the ones that are not what the css says they are */
	async check(): Promise<void> {
		const resources = this.resources;
		const total = resources.remote.length;
		if (total === 0) return;
		trace.log(`${this.url} ${resources.describe()}`);
		try {
			const failures = await resources.check((done, files) => {
				resourceProgress._ = { ...resourceProgress._, [this.url]: { done, total: files } };
			});
			for (const { resource, error } of failures) trace.warn(`${resource.absolute} ${error.message}`);
			trace.log(`Checked ${total} file(s) for ${this.url}, ${failures.length} problem(s)`);
		} finally {
			// The row goes back to its normal line once the check is done, pass or fail
			const next = { ...resourceProgress._ };
			delete next[this.url];
			resourceProgress._ = next;
		}
	}

	/** Uninstall: stop styling the page and forget the theme */
	remove(): void {
		Theme.registry.delete(this.url);
		super.remove();
	}

	/** Put a theme's css in place, storing it so the next start needs no request */
	private apply(css: string): void {
		this.data.css = css;
		this.cleanCss = css.trim();
		this.cachedManifest = undefined;
		this.cachedResources = undefined;
		// A disabled theme still stores what it downloaded; only an enabled one is on the page
		if (this.data.enabled) this.css = css;
	}
}
