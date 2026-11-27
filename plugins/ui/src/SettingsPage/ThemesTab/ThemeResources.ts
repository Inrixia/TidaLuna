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
 * A theme's resources are read from its css once, and everything a row or a prompt needs about them hangs off that:
 * the summary on the row, the consent prompt before install, and the check of each file once it is installed.
 * Network access is the only thing injected, so the rules and the prompt can be tested without one.
 */

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

/** One file a theme would download, named the way a person reads it */
export type ThemeConsentFile = { label: string; url: string };

/** The files a theme downloads from one host */
export type ThemeConsentHost = { host: string; files: ThemeConsentFile[]; hidden: number };

/** What to ask before a theme that pulls in other files is installed */
export type ThemeConsent = {
	required: boolean;
	title: string;
	/** The one-line summary: how many, of what kind, from where */
	description: string;
	/** The files themselves, grouped by the host they come from, so the prompt names them rather than counting them */
	hosts: ThemeConsentHost[];
	confirmationText: string;
};

/** A file that is not what the css says it is, and why */
export type ResourceFailure = { resource: ThemeResource; error: Error };

/** How often a theme's files are requested at once. Bounded so a font pack does not open thirteen sockets. */
const concurrency = 6;
/** How many files a prompt lists before it says "and N more": a wall of 40 urls is not a decision anyone makes */
const maxListedFiles = 12;

const fontExtensions = [".woff2", ".woff", ".ttf", ".otf", ".eot"];
const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico"];

export class ThemeResources {
	public constructor(public readonly resources: ThemeResource[]) {}

	/** The resources a stylesheet references, so they can be checked and reported */
	static of(css: string, baseUrl?: string): ThemeResources {
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
			const extension = ThemeResources.extensionOf(raw.split("?")[0].split("#")[0]);
			const kind = fontExtensions.includes(extension) ? "font" : imageExtensions.includes(extension) ? "image" : "other";
			found.push({ url: raw, absolute: absoluteOf(raw), kind, imported: false });
		}
		return new ThemeResources(found);
	}

	/**
	 * The files this theme fetches from the network.
	 *
	 * A `data:` url is inside the css already and fetches nothing, so it is not something to check, count or ask about.
	 */
	public get remote(): ThemeResource[] {
		return this.resources.filter((resource) => resource.absolute?.startsWith("http") ?? false);
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
	 * The guard shown when a theme loads files of its own.
	 *
	 * A theme is css, but it can name anything to fetch: the font pack installs thirteen binaries from github.com. Installing
	 * it is the moment the user is still deciding, so the files and their hosts are put in front of them first, rather than a
	 * log line they will never read.
	 */
	public consent(name: string): ThemeConsent {
		const remote = this.remote;
		if (remote.length === 0) return { required: false, title: "", description: "", hosts: [], confirmationText: "" };

		const fonts = remote.filter((resource) => resource.kind === "font").length;
		const images = remote.filter((resource) => resource.kind === "image").length;
		const imported = remote.filter((resource) => resource.imported).length;

		// Group by host: where a file comes from is the thing being agreed to, and the files are what it is
		const byHost = new Map<string, string[]>();
		for (const resource of remote) {
			const url = resource.absolute!;
			const host = new URL(url).hostname;
			const urls = byHost.get(host);
			if (urls === undefined) byHost.set(host, [url]);
			else urls.push(url);
		}

		// A font pack can name the same file from several @font-face rules (four use BOXRounded-Bold.ttf here). It downloads
		// once, so list it once: repeating it three times reads like three files. Hosts are sorted so the prompt reads the
		// same way every time, and listing stops once the prompt has enough file names to be a decision.
		const hosts: ThemeConsentHost[] = [];
		let remaining = maxListedFiles;
		for (const [host, urls] of [...byHost].sort(([a], [b]) => a.localeCompare(b))) {
			const files: ThemeConsentFile[] = [];
			let hidden = 0;
			const seen = new Set<string>();
			for (const url of urls) {
				if (seen.has(url)) continue;
				seen.add(url);
				if (remaining === 0) {
					hidden++;
					continue;
				}
				remaining--;
				files.push({ label: ThemeResources.labelOf(url), url });
			}
			hosts.push({ host, files, hidden });
		}

		const files = `${remote.length} file${remote.length === 1 ? "" : "s"}`;
		const what = [
			fonts > 0 ? `${fonts} font${fonts === 1 ? "" : "s"}` : undefined,
			images > 0 ? `${images} image${images === 1 ? "" : "s"}` : undefined,
			imported > 0 ? `${imported} imported stylesheet${imported === 1 ? "" : "s"}` : undefined,
		].filter(Boolean);

		return {
			required: true,
			title: "This theme downloads files",
			description:
				`${name} downloads ${files} from ${[...byHost.keys()].sort().join(", ")}` +
				(what.length > 0 ? ` (${what.join(", ")})` : "") +
				". Anything it downloads can change later without asking again.",
			hosts,
			confirmationText: "Install theme",
		};
	}

	/**
	 * Check every file a theme loads, several at a time.
	 *
	 * There is deliberately no ceiling on how many files are checked. A limit is exploitable: a theme that names twenty
	 * harmless files and then its hostile one would never have the hostile one looked at, and the cap silently turns the
	 * check into a decoration. Instead the work is bounded by running a few requests at once and the caller reports progress,
	 * so a theme naming a hundred files still finishes and still gets every file looked at.
	 *
	 * A file that fails is returned rather than thrown: one bad font is not a reason to drop a theme that otherwise works,
	 * but it is a reason to say so.
	 */
	public async check(onProgress?: (done: number, total: number) => void): Promise<ResourceFailure[]> {
		// Repeated urls are checked once. A font pack can point four @font-face rules at one file, and those are one download.
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
						await ThemeResources.verify(resource);
					} finally {
						done++;
						onProgress?.(done, total);
					}
				}),
			),
		);

		const failures: ResourceFailure[] = [];
		for (const [index, result] of results.entries()) {
			if (result.status === "fulfilled") continue;
			const reason: unknown = result.reason;
			failures.push({ resource: unique[index], error: reason instanceof Error ? reason : new Error(String(reason)) });
		}
		return failures;
	}

	/**
	 * Whether a response body is a stylesheet, thrown as an error when it is not.
	 *
	 * The install path is the one place a url is still a decision, so a url that answers with a web page or json is refused
	 * before it is stored as css and silently restyles nothing.
	 */
	static assertStylesheet(body: string, contentType?: string | null): void {
		// An error page is the common case: github serves HTML for a missing raw file, and for every /blob/ page
		const start = body.trimStart().slice(0, 200).toLowerCase();
		if (start.startsWith("<!doctype html") || start.startsWith("<html")) throw new Error("That url returned a web page, not a stylesheet");
		if (start.startsWith("<?xml") && start.includes("<html")) throw new Error("That url returned a web page, not a stylesheet");
		if (start.startsWith("{") || start.startsWith("[")) throw new Error("That url returned json, not a stylesheet");
		if (start.startsWith("404:") || start.startsWith("not found")) throw new Error("That url returned an error, not a stylesheet");
		if (contentType !== undefined && contentType !== null) {
			const type = contentType.toLowerCase();
			if (type.includes("text/html")) throw new Error("That url returned a web page, not a stylesheet");
			if (type.includes("application/json")) throw new Error("That url returned json, not a stylesheet");
		}
		// A stylesheet has at least one rule or an at-rule; an empty body is refused because it restyles nothing
		if (body.trim() === "") throw new Error("That url returned an empty body");
		if (!body.includes("{") && !body.includes("@")) throw new Error("That url does not look like css");
	}

	/** The content types a font is actually served with; anything else means the url is not a font */
	static isFontContentType(contentType: string | null | undefined): boolean {
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

	/** The content types an image is served with */
	static isImageContentType(contentType: string | null | undefined): boolean {
		if (contentType === null || contentType === undefined) return false;
		return contentType.toLowerCase().split(";")[0].trim().startsWith("image/");
	}

	/**
	 * What is wrong with a resource's response, thrown.
	 *
	 * A font is judged by its content type rather than its extension: hosts serve fonts as octet-stream and sometimes from a
	 * url with no extension at all, and an html page called `font.woff2` is still not a font.
	 */
	private static async verify(resource: ThemeResource): Promise<void> {
		let response: Response;
		try {
			response = await fetch(resource.absolute!, { method: "HEAD" });
		} catch (e) {
			throw new Error("could not be checked", { cause: e });
		}
		if (response.status === 0 || response.status >= 400) {
			throw new Error(`answered ${response.status === 0 ? "nothing" : `HTTP ${response.status}`}`);
		}
		const contentType = response.headers.get("content-type");
		if (resource.kind === "font" && !ThemeResources.isFontContentType(contentType)) {
			throw new Error(`is not a font (${contentType ?? "no content type"})`);
		}
		if (resource.kind === "image" && !ThemeResources.isImageContentType(contentType)) {
			throw new Error(`is not an image (${contentType ?? "no content type"})`);
		}
		if (resource.imported && !(contentType ?? "").toLowerCase().includes("css")) {
			throw new Error(`is not a stylesheet (${contentType ?? "no content type"})`);
		}
	}

	/**
	 * The last path segment, which is the part that names a font or an image.
	 *
	 * A theme's file urls share a long prefix (`…/raw/refs/heads/main/fontdatabase2/tech/`), so listing them whole hides the
	 * one thing that differs.
	 */
	private static labelOf(url: string): string {
		try {
			const path = new URL(url).pathname.split("/").filter(Boolean);
			return decodeURIComponent(path[path.length - 1] ?? url);
		} catch {
			return url;
		}
	}

	/** The extension of a url's last path segment, lowercased, or "" when it has none */
	private static extensionOf(path: string): string {
		const last = path.split("/").pop() ?? "";
		const dot = last.lastIndexOf(".");
		return dot === -1 ? "" : last.slice(dot).toLowerCase();
	}
}
