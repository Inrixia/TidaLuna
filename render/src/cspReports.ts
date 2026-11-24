import { coreTrace } from "./trace";

// Logs the violations of the two policies native/cspReportOnly.ts sends with the TIDAL shell: the report-only one (nothing
// blocked, it maps which hosts TIDAL and plugins really use) and the enforced connect-src (blocked: `enforced`, shown in
// Luna Settings > Network, and as a toast by pageNet.ts).
// No attribution to plugins: every fetch goes through Luna's request cache hook, so its reports name https://luna.

const trace = coreTrace.withSource(".CSP").trace;

export type CspReport = {
	/** e.g. connect-src, script-src-elem, font-src */
	directive: string;
	/** Origin of what was reported, or its kind (inline, eval, data, blob) */
	blocked: string;
	/** Origin of the script the browser names for the report (https://luna for every fetch) */
	sourceFile: string;
	count: number;
	/** Blocked by the enforced policy, not only reported */
	enforced?: true;
};

/** Distinct reports since the page loaded, keyed by directive, blocked and sourceFile */
export const cspReports = new Map<string, CspReport>();
// A plugin hitting random subdomains would grow the map and the log forever; past this only cspReportsDropped counts
const maxReports = 500;
/** Reports not kept because cspReports is full */
export const cspReportsDropped = { count: 0 };

/**
 * What a report names, reduced to an origin (`https://example.com`) so one host is one report whatever its paths and
 * queries (they can carry user data). URLs without an origin (`data:`, `blob:`) give their scheme, keywords stay as they are
 */
const originOf = (uri: string) => {
	try {
		const url = new URL(uri);
		return url.origin !== "null" ? url.origin : url.protocol.slice(0, -1);
	} catch {
		// "inline", "eval", "wasm-eval" or empty
		return uri || "unknown";
	}
};

// The browser fires securitypolicyviolation for each violation of the page's policies: at the element that caused it (an
// <img> whose src isn't allowed) or at the document, and it bubbles, so the document hears all of them
document.addEventListener("securitypolicyviolation", (event) => {
	// Both policies: report-only reports are what TIDAL's policy would block, enforced ones what Luna's strict network
	// blocked (Settings > Network, "Blocked in the page")
	const enforced = event.disposition === "enforce";
	// effectiveDirective is the directive that applied (img-src, not default-src it fell back to)
	const blocked = originOf(event.blockedURI);
	const sourceFile = originOf(event.sourceFile);
	const key = `${enforced ? "enforce" : "report"} ${event.effectiveDirective} ${blocked} ${sourceFile}`;
	const report = cspReports.get(key);
	// Seen before: only counted, so a plugin polling a host doesn't flood the log
	if (report !== undefined) {
		report.count++;
		return;
	}
	// Full: counted as dropped, warned about once
	if (cspReports.size >= maxReports) {
		if (cspReportsDropped.count++ === 0) trace.warn(`CSP report-only: over ${maxReports} distinct reports, not logging more`);
		return;
	}
	// New: kept and logged once, Settings and luna.core.cspReports read the map
	cspReports.set(key, { directive: event.effectiveDirective, blocked, sourceFile, count: 1, ...(enforced ? { enforced: true as const } : {}) });
	if (enforced) trace.warn(`CSP blocked: ${event.effectiveDirective} ${blocked} (from ${sourceFile})`);
	else trace.log(`CSP report-only: ${event.effectiveDirective} ${blocked} (from ${sourceFile})`);
});
