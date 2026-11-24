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

const metaMarker = 'http-equiv="Content-Security-Policy"';

/**
 * The content of the TIDAL shell's CSP meta tag, or undefined without one. Runs on each load of the shell (injector.ts):
 * it finds the marker with indexOf and reads only that tag, the rest of the page isn't scanned
 */
export const tidalMetaPolicy = (html: string): string | undefined => {
	for (let at = html.indexOf(metaMarker); at !== -1; at = html.indexOf(metaMarker, at + 1)) {
		const start = html.lastIndexOf("<meta", at);
		const end = html.indexOf(">", at);
		if (end === -1) return undefined;
		// The marker must be inside that <meta> tag (no ">" between them), not in text or a script before it
		if (start === -1 || html.lastIndexOf(">", at) > start) continue;
		const content = /\scontent="([^"]*)"/i.exec(html.slice(start, end + 1))?.[1];
		return content === undefined ? undefined : decodeAttribute(content);
	}
	return undefined;
};

/** A directive (`name source source`) with the sources it doesn't have yet added at its end */
const withSources = (directive: string, sources: string[]) => {
	const present = new Set(directive.split(" ").slice(1));
	const missing = sources.filter((source) => !present.has(source));
	return missing.length === 0 ? directive : `${directive} ${missing.join(" ")}`;
};

/**
 * The report-only policy for a TIDAL policy (from tidalMetaPolicy). TIDAL's directives are kept as they are, in their
 * order: only header-only ones are left out, script-src gets Luna's sources, and network directives TIDAL leaves open get
 * the baseline
 */
export const reportOnlyPolicy = (tidalPolicy: string): string => {
	const kept: string[] = [];
	const names = new Set<string>();
	for (const part of tidalPolicy.split(";")) {
		const directive = part.trim().replace(/\s+/g, " ");
		const space = directive.indexOf(" ");
		const name = (space === -1 ? directive : directive.slice(0, space)).toLowerCase();
		// The first of two same-named directives wins in CSP, keep that one
		if (name === "" || headerOnlyDirectives.has(name) || names.has(name)) continue;
		names.add(name);
		kept.push(name === "script-src" ? withSources(directive, lunaScriptSources) : directive);
	}
	// With default-src set the network directives already fall back to it; only fill what is open
	if (!names.has("default-src")) for (const name of networkDirectives) if (!names.has(name)) kept.push(`${name} ${networkBaseline.join(" ")}`);
	return kept.join("; ");
};

let lastHeader: { tidalPolicy: string; header: string } | undefined;
/**
 * reportOnlyPolicy, built again only when TIDAL's policy changes (each shell load asks for it). The key is everything the
 * policy is built from: a new input to reportOnlyPolicy has to be part of it
 */
export const reportOnlyHeader = (tidalPolicy: string): string => {
	if (lastHeader?.tidalPolicy !== tidalPolicy) lastHeader = { tidalPolicy, header: reportOnlyPolicy(tidalPolicy) };
	return lastHeader.header;
};
