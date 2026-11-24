// Luna removes TIDAL's CSP meta tag (see injector.ts). This builds a Content-Security-Policy-Report-Only header for the
// TIDAL shell instead: TIDAL's own policy plus what Luna itself needs, and the network directives TIDAL leaves open.
// The browser blocks nothing for it, it only fires securitypolicyviolation events (logged by render/src/cspReports.ts),
// so we learn what restoring TIDAL's policy, or a host list for plugins, would break.

// Luna's own code: core bundles from https://luna/, TIDAL modules through luna-module://, plugins and quartz as blob:
const lunaScriptSources = ["https://luna", "luna-module:"];

// For the directives TIDAL's policy doesn't set: the hosts TIDAL's own policy names, what TIDAL 2.48 was seen using
// (squareup), and Luna's plugin stores and updates on GitHub. Anything else is reported, loopback too on purpose:
// dev plugin stores show up, and so do plugins talking to local services
export const networkBaseline = [
	"'self'",
	"https://luna",
	"luna-module:",
	"blob:",
	"data:",
	"tidal.com",
	"*.tidal.com",
	// Chromium doesn't count a source without a scheme for wss: TIDAL's push socket (wss://pushkin-v2.tidal.com)
	"wss://tidal.com",
	"wss://*.tidal.com",
	// @luna/lib's own MusicBrainz lookups (Album, MediaItem)
	"musicbrainz.org",
	"*.gstatic.com",
	"*.stripe.com",
	"*.cookielaw.org",
	"*.squarecdn.com",
	"*.squareup.com",
	"github.com",
	"api.github.com",
	"*.githubusercontent.com",
];

// Directives TIDAL leaves open that decide where page code can send data or load media from
const networkDirectives = ["connect-src", "img-src", "media-src", "frame-src"];

// Ignored in a meta tag but live in a header: reporting would send every violation to whoever TIDAL names,
// frame-ancestors and sandbox would change how the shell may be framed or run
const headerOnlyDirectives = new Set(["report-uri", "report-to", "frame-ancestors", "sandbox"]);

const decodeAttribute = (value: string) =>
	value
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");

// The GitHub hosts plugins, stores and releases are served from: host entries refuse `*.githubusercontent.com` (a
// public suffix: anyone's pages), which the CSP itself lists
const githubContent = ["raw.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "media.githubusercontent.com"];
/**
 * The baseline's hosts as host entries (core/hosts.ts), for page code that checks a url before it sends it
 * (render/src/pageNet.ts) and for the store gate (core/stores.ts). `'self'` is the TIDAL shell, under tidal.com;
 * `https://luna` is Luna's own origin, which pageNet lets through by itself
 */
export const baselineEntries = [
	...networkBaseline.filter((source) => /^(\*\.)?[a-z0-9.-]+\.[a-z]+$/.test(source) && source !== "*.githubusercontent.com"),
	...githubContent,
];

/**
 * The enforced policy sent with the TIDAL shell, next to the report-only one: page code (TIDAL, Luna and every page
 * plugin) reaches with fetch, XMLHttpRequest, WebSocket, EventSource and sendBeacon only TIDAL, Luna's own and the
 * plugins' accepted hosts. Images and media stay open to any https: loading one runs no code, and the url it could
 * leak data through is the one risk left (Inrixia: not worth the cost of holding them to the same hosts).
 *
 * @param pluginSources CSP sources of the hosts enabled plugins may reach (core/hosts.ts cspSources of registry pageHosts)
 */
export const enforcedPolicy = (pluginSources: string[]): string =>
	`connect-src ${[...networkBaseline, ...pluginSources.filter((s) => !networkBaseline.includes(s))].join(" ")}`;

/** The content of the TIDAL shell's CSP meta tag, or undefined without one */
export const tidalMetaPolicy = (html: string): string | undefined => {
	const tag = /<meta\s[^>]*http-equiv="Content-Security-Policy"[^>]*>/i.exec(html)?.[0];
	if (tag === undefined) return undefined;
	const content = /\scontent="([^"]*)"/i.exec(tag)?.[1];
	return content === undefined ? undefined : decodeAttribute(content);
};

// Where a plugin's declared hosts (core/hosts.ts) are listed: what it fetches, and the images and media it shows
const pluginDirectives = new Set(["connect-src", "img-src", "media-src"]);

/**
 * The report-only policy for a TIDAL policy (from tidalMetaPolicy)
 *
 * @param pluginSources CSP sources for the hosts enabled plugins declare (core/hosts.ts cspSources): only what no plugin
 * declared is reported. Shared by every plugin: the page's realm doesn't tell plugins apart, luna.fetch does (core/net.ts)
 */
export const reportOnlyPolicy = (tidalPolicy: string, pluginSources: string[] = []): string => {
	const directives = new Map<string, string[]>();
	for (const part of tidalPolicy.split(";")) {
		const [rawName, ...values] = part.trim().split(/\s+/);
		const name = rawName?.toLowerCase();
		if (!name || headerOnlyDirectives.has(name)) continue;
		// The first of two same-named directives wins in CSP, keep that one
		if (!directives.has(name)) directives.set(name, values);
	}
	const scriptSources = directives.get("script-src");
	if (scriptSources !== undefined)
		directives.set("script-src", [...scriptSources, ...lunaScriptSources.filter((s) => !scriptSources.includes(s))]);
	// With default-src set the network directives already fall back to it; only fill what is open
	if (!directives.has("default-src")) {
		for (const directive of networkDirectives) {
			if (directives.has(directive)) continue;
			const sources = pluginDirectives.has(directive) ? [...networkBaseline, ...pluginSources.filter((s) => !networkBaseline.includes(s))] : networkBaseline;
			directives.set(directive, sources);
		}
	}
	return [...directives].map(([name, values]) => [name, ...values].join(" ")).join("; ");
};
