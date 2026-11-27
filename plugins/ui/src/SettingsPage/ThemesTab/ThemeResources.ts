/**
 * Checking that what a theme says it loads is what it actually loads.
 *
 * Two things go wrong with a theme that a `.css` suffix does not catch:
 *
 *  - the url serves something that is not a stylesheet. A raw github url for a missing file answers with an HTML error
 *    page, a gist page answers with HTML, an API url answers with JSON. Stored as css it silently does nothing.
 *  - a `@font-face` points at something that is not a font, so the text it was meant to restyle falls back and the
 *    theme looks broken for a reason nobody can see.
 *
 * A theme's resources are read from its css once, when the class is created, so everything that asks about them (the row's
 * summary, the consent prompt, the check of each file) is asking about the same list.
 */

import { fileExtension, urlFileName } from "@luna/lib";
import { Semaphore } from "@inrixia/helpers";

export type ThemeResource = {
	/** The url as written in the css */
	url: string;
	/** Absolute url, when it can be resolved against the theme's own url */
	absolute: string | undefined;
	kind: "font" | "image" | "stylesheet" | "other";
	/** True for @import, which is a stylesheet whose content can change after the theme was approved */
	imported: boolean;
};

/** How often a theme's files are requested at once. Bounded so a font pack does not open thirteen sockets. */
const concurrency = 6;

const fontExtensions = [".woff2", ".woff", ".ttf", ".otf", ".eot"];
const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico"];

export class ThemeResources {
	/**
	 * Read once per url, replaced when the stylesheet at that url changes.
	 *
	 * Keyed by url rather than by the css: a stylesheet is replaced whole, and keying on the css kept every version of it
	 * alive for the life of the page, in a map that also had to compare a few hundred KB per lookup.
	 */
	private static readonly created = new Map<string, { css: string; resources: ThemeResources }>();

	/** The resources a stylesheet references, so they can be checked and reported */
	static from(css: string, baseUrl?: string): ThemeResources {
		const key = baseUrl ?? "";
		const known = ThemeResources.created.get(key);
		if (known !== undefined && known.css === css) return known.resources;
		const resources = new ThemeResources(ThemeResources.parse(css, baseUrl));
		ThemeResources.created.set(key, { css, resources });
		return resources;
	}

	public readonly resources: ThemeResource[];

	/**
	 * The files this theme fetches from the network.
	 *
	 * A `data:` url is inside the css already and fetches nothing, so it is not something to check, count or ask about.
	 * Worked out once, because a row and a check both ask, and asking meant filtering the whole list per question.
	 */
	public readonly remote: ThemeResource[];

	private constructor(resources: ThemeResource[]) {
		this.resources = resources;
		this.remote = resources.filter((resource) => resource.absolute?.startsWith("http") ?? false);
	}

	/** A one-line summary of what a theme loads, for its row */
	public describe(): string | undefined {
		const remote = this.remote;
		if (remote.length === 0) return undefined;
		const fonts = remote.filter((resource) => resource.kind === "font").length;
		const imported = remote.filter((resource) => resource.imported).length;
		const origins = [...new Set(remote.map((resource) => new URL(resource.absolute!).hostname))];
		const parts = [`loads ${remote.length} file${remote.length === 1 ? "" : "s"}`];
		if (fonts > 0) parts.push(`${fonts} font${fonts === 1 ? "" : "s"}`);
		if (imported > 0) parts.push(`${imported} imported stylesheet${imported === 1 ? "" : "s"}`);
		if (origins.length > 0) parts.push(`from ${origins.join(", ")}`);
		return parts.join(", ");
	}

	/**
	 * Check every file a theme loads, several at a time, throwing on the first that is not what the css says it is.
	 *
	 * There is deliberately no ceiling on how many files are checked. A limit is exploitable: a theme that names twenty
	 * harmless files and then its hostile one would never have the hostile one looked at, and the cap silently turns the
	 * check into a decoration. A few requests run at once instead, so a theme naming a hundred files still finishes.
	 *
	 * The first failure is the one reported, and only once every file has been looked at: the caller clears the row's
	 * progress when this returns, so a file still in flight would write a progress line nothing ever clears again.
	 */
	public async check(onProgress?: (done: number, total: number) => void): Promise<void> {
		// Repeated urls are checked once. A font pack can point four @font-face rules at one file, and those are one download
		const seen = new Set<string>();
		const unique = this.remote.filter((resource) => {
			const url = resource.absolute!;
			if (seen.has(url)) return false;
			seen.add(url);
			return true;
		});

		const total = unique.length;
		const semaphore = new Semaphore(concurrency);
		let done = 0;
		const results = await Promise.allSettled(
			unique.map((resource) =>
				semaphore.with(async () => {
					try {
						await this.verify(resource);
					} finally {
						done++;
						onProgress?.(done, total);
					}
				}),
			),
		);
		for (const result of results) if (result.status === "rejected") throw result.reason;
	}

	/**
	 * What is wrong with a resource's response, thrown.
	 *
	 * A font is judged by its content type rather than its extension: hosts serve fonts as octet-stream and sometimes from a
	 * url with no extension at all, and an html page called `font.woff2` is still not a font.
	 */
	private async verify(resource: ThemeResource): Promise<void> {
		const url = resource.absolute!;
		const name = urlFileName(url) ?? url;
		let response: Response;
		try {
			response = await fetch(url, { method: "HEAD" });
		} catch (e) {
			throw new Error(`${name} could not be checked`, { cause: e });
		}
		if (response.status === 0 || response.status >= 400) {
			throw new Error(`${name} answered ${response.status === 0 ? "nothing" : `HTTP ${response.status}`}`);
		}
		const contentType = response.headers.get("content-type");
		if (resource.kind === "font" && !this.isFont(contentType)) throw new Error(`${name} is not a font (${contentType ?? "no content type"})`);
		if (resource.kind === "image" && !this.isImage(contentType)) throw new Error(`${name} is not an image (${contentType ?? "no content type"})`);
		if (resource.imported && !(contentType ?? "").toLowerCase().includes("css")) {
			throw new Error(`${name} is not a stylesheet (${contentType ?? "no content type"})`);
		}
	}

	/** The content types an image is served with */
	private isImage(contentType: string | null | undefined): boolean {
		if (contentType === null || contentType === undefined) return false;
		return contentType.toLowerCase().split(";")[0].trim().startsWith("image/");
	}

	/** The content types a font is actually served with; anything else means the url is not a font */
	private isFont(contentType: string | null | undefined): boolean {
		if (contentType === null || contentType === undefined) return false;
		const type = contentType.toLowerCase().split(";")[0].trim();
		return (
			type.startsWith("font/") ||
			type.startsWith("application/font") ||
			type === "application/vnd.ms-fontobject" ||
			type === "application/x-font-ttf" ||
			type === "application/x-font-opentype" ||
			// Some hosts send fonts as a generic binary
			type === "application/octet-stream"
		);
	}

	/** The urls a stylesheet references, in the order they appear */
	private static parse(css: string, baseUrl?: string): ThemeResource[] {
		const found: ThemeResource[] = [];
		// An absolute url needs no base; a relative one is resolved against the stylesheet's own url when that is known
		const absoluteOf = (raw: string) => {
			try {
				return new URL(raw, baseUrl).href;
			} catch {
				return undefined;
			}
		};

		// @import "x.css" / @import url(x.css)
		for (const match of css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?/gi)) {
			const raw = match[1];
			found.push({ url: raw, absolute: absoluteOf(raw), kind: "stylesheet", imported: true });
		}

		// url(...) everywhere else
		for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
			const raw = match[1].trim();
			// @import url() is already recorded above
			if (found.some((resource) => resource.url === raw && resource.imported)) continue;
			const extension = fileExtension(raw);
			const kind = fontExtensions.includes(extension) ? "font" : imageExtensions.includes(extension) ? "image" : "other";
			found.push({ url: raw, absolute: absoluteOf(raw), kind, imported: false });
		}
		return found;
	}
}
