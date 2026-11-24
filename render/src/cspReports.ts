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

const originOf = (uri: string) => {
	try {
		const url = new URL(uri);
		return url.origin !== "null" ? url.origin : url.protocol.slice(0, -1);
	} catch {
		// "inline", "eval", "wasm-eval" or empty
		return uri || "unknown";
	}
};

document.addEventListener("securitypolicyviolation", (event) => {
	const enforced = event.disposition === "enforce";
	const blocked = originOf(event.blockedURI);
	const sourceFile = originOf(event.sourceFile);
	const key = `${enforced ? "enforce" : "report"} ${event.effectiveDirective} ${blocked} ${sourceFile}`;
	const report = cspReports.get(key);
	if (report !== undefined) {
		report.count++;
		return;
	}
	if (cspReports.size >= maxReports) {
		if (cspReportsDropped.count++ === 0) trace.warn(`CSP report-only: over ${maxReports} distinct reports, not logging more`);
		return;
	}
	cspReports.set(key, { directive: event.effectiveDirective, blocked, sourceFile, count: 1, ...(enforced ? { enforced: true as const } : {}) });
	if (enforced) trace.warn(`CSP blocked: ${event.effectiveDirective} ${blocked} (from ${sourceFile})`);
	else trace.log(`CSP report-only: ${event.effectiveDirective} ${blocked} (from ${sourceFile})`);
});
