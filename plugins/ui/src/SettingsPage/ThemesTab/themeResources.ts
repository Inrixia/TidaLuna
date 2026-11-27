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
 * Everything here is pure so the rules can be tested directly; the caller does the fetching.
 */

export type ThemeResource = {
	/** The url as written in the css */
	url: string;
	/** Absolute url, when it can be resolved against the theme's own url */
	absolute: string | undefined;
	kind: "font" | "image" | "stylesheet" | "other";
	/** True for @import, which is a stylesheet whose content can change after the theme was approved */
	imported: boolean;
};

const fontExtensions = [".woff2", ".woff", ".ttf", ".otf", ".eot"];
const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico"];

const extensionOf = (path: string): string => {
	const last = path.split("/").pop() ?? "";
	const dot = last.lastIndexOf(".");
	return dot === -1 ? "" : last.slice(dot).toLowerCase();
};

/** Whether a response body is a stylesheet rather than something a web server answered with instead */
export const stylesheetProblem = (body: string, contentType?: string | null): string | undefined => {
	// An error page is the common case: github serves HTML for a missing raw file, and for every /blob/ page
	const start = body.trimStart().slice(0, 200).toLowerCase();
	if (start.startsWith("<!doctype html") || start.startsWith("<html")) return "the url returned a web page, not a stylesheet";
	if (start.startsWith("<?xml") && start.includes("<html")) return "the url returned a web page, not a stylesheet";
	if (start.startsWith("{") || start.startsWith("[")) return "the url returned json, not a stylesheet";
	if (start.startsWith("404:") || start.startsWith("not found")) return "the url returned an error, not a stylesheet";
	if (contentType !== undefined && contentType !== null) {
		const type = contentType.toLowerCase();
		if (type.includes("text/html")) return "the url returned a web page, not a stylesheet";
		if (type.includes("application/json")) return "the url returned json, not a stylesheet";
	}
	// A stylesheet has at least one rule or an at-rule; an empty body is treated as broken because it restyles nothing
	if (body.trim() === "") return "the url returned an empty body";
	if (!body.includes("{") && !body.includes("@")) return "the body does not look like css";
	return undefined;
};

/** The resources a stylesheet references, so they can be checked and reported */
export const parseThemeResources = (css: string, baseUrl?: string): ThemeResource[] => {
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
		const extension = extensionOf(raw.split("?")[0].split("#")[0]);
		const kind = fontExtensions.includes(extension) ? "font" : imageExtensions.includes(extension) ? "image" : "other";
		found.push({ url: raw, absolute: absoluteOf(raw), kind, imported: false });
	}
	return found;
};

/** The content types a font is actually served with; anything else means the url is not a font */
export const isFontContentType = (contentType: string | null | undefined): boolean => {
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
};

/** The content types an image is served with */
export const isImageContentType = (contentType: string | null | undefined): boolean => {
	if (contentType === null || contentType === undefined) return false;
	const type = contentType.toLowerCase().split(";")[0].trim();
	return type.startsWith("image/");
};

export type ResourceCheck = { resource: ThemeResource; problem: string };

/**
 * What is wrong with a resource's response, or undefined when it is fine.
 *
 * A font is judged by its content type rather than its extension: hosts serve fonts as octet-stream and sometimes from a
 * url with no extension at all, and an html page called `font.woff2` is still not a font.
 */
export const resourceProblem = (resource: ThemeResource, status: number, contentType: string | null | undefined): string | undefined => {
	if (status === 0 || status >= 400) return `answered ${status === 0 ? "nothing" : `HTTP ${status}`}`;
	if (resource.kind === "font" && !isFontContentType(contentType)) {
		return `is not a font (${contentType ?? "no content type"})`;
	}
	if (resource.kind === "image" && !isImageContentType(contentType)) {
		return `is not an image (${contentType ?? "no content type"})`;
	}
	if (resource.imported && !(contentType ?? "").toLowerCase().includes("css")) {
		return `is not a stylesheet (${contentType ?? "no content type"})`;
	}
	return undefined;
};

/** A one-line summary of what a theme loads, for its row */
export const describeResources = (resources: ThemeResource[]): string | undefined => {
	if (resources.length === 0) return undefined;
	const remote = resources.filter((resource) => resource.absolute?.startsWith("http") ?? false);
	const fonts = resources.filter((resource) => resource.kind === "font").length;
	const imported = resources.filter((resource) => resource.imported).length;
	const origins = [...new Set(remote.map((resource) => new URL(resource.absolute!).hostname))];
	const parts = [`loads ${resources.length} file${resources.length === 1 ? "" : "s"}`];
	if (fonts > 0) parts.push(`${fonts} font${fonts === 1 ? "" : "s"}`);
	if (imported > 0) parts.push(`${imported} imported stylesheet${imported === 1 ? "" : "s"}`);
	if (origins.length > 0) parts.push(`from ${origins.join(", ")}`);
	return parts.join(", ");
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

/** How many files a prompt lists before it says "and N more": a wall of 40 urls is not a decision anyone makes */
const maxListedFiles = 12;

/**
 * The last path segment, which is the part that names a font or an image.
 *
 * A theme's file urls share a long prefix (`…/raw/refs/heads/main/fontdatabase2/tech/`), so listing them whole hides the
 * one thing that differs.
 */
const labelOf = (url: string): string => {
	try {
		const path = new URL(url).pathname.split("/").filter(Boolean);
		return decodeURIComponent(path[path.length - 1] ?? url);
	} catch {
		return url;
	}
};

/**
 * The guard shown when a theme loads files of its own.
 *
 * A theme is css, but it can name anything to fetch: the font pack installs thirteen binaries from github.com. Installing
 * it is the moment the user is still deciding, so the files and their hosts are put in front of them first, rather than a
 * log line they will never read.
 *
 * Only remote files count: a `data:` url is inside the css already and fetches nothing.
 */
export const themeConsent = (name: string, resources: ThemeResource[]): ThemeConsent => {
	const remote = resources.filter((resource) => resource.absolute?.startsWith("http") ?? false);
	if (remote.length === 0) {
		return { required: false, title: "", description: "", hosts: [], confirmationText: "" };
	}

	const fonts = remote.filter((resource) => resource.kind === "font").length;
	const images = remote.filter((resource) => resource.kind === "image").length;
	const imported = remote.filter((resource) => resource.imported).length;

	// Group by host: where a file comes from is the thing being agreed to, and the files are what it is
	const byHost = new Map<string, ThemeConsentFile[]>();
	for (const resource of remote) {
		const host = new URL(resource.absolute!).hostname;
		const files = byHost.get(host) ?? [];
		files.push({ label: labelOf(resource.absolute!), url: resource.absolute! });
		byHost.set(host, files);
	}

	// A font pack can name the same file from several @font-face rules (four use BOXRounded-Bold.ttf here). It downloads
	// once, so list it once: repeating it three times reads like three files.
	let budget = maxListedFiles;
	const hosts: ThemeConsentHost[] = [...byHost.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([host, files]) => {
			const seen = new Set<string>();
			const unique = files.filter((file) => (seen.has(file.url) ? false : (seen.add(file.url), true)));
			const listed = unique.slice(0, Math.max(0, budget));
			budget -= listed.length;
			return { host, files: listed, hidden: unique.length - listed.length };
		});

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
};
