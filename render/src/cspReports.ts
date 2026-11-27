import { keepReport, type CspReport } from "./helpers/cspReportKeep";
import { coreTrace } from "./trace";

// Logs the violations of the two policies native/cspReportOnly.ts sends with the TIDAL shell: the report-only one (nothing
// blocked, it maps which hosts TIDAL and plugins really use) and the enforced connect-src (blocked: `enforced`, shown in
// Luna Settings > Network, and as a toast by pageNet.ts).
// No attribution to plugins: every fetch goes through Luna's request cache hook, so its reports name https://luna.

const trace = coreTrace.withSource(".CSP").trace;

export type { CspReport };

/** Distinct reports since the page loaded, keyed by directive, blocked and sourceFile */
export const cspReports = new Map<string, CspReport>();
// A plugin hitting random subdomains would grow the map and the log forever; past this only cspReportsDropped counts
const maxReports = 500;
/** Reports not kept because cspReports is full */
export const cspReportsDropped = { count: 0 };

// The browser fires securitypolicyviolation for each violation of the page's policies: at the element that caused it (an
// <img> whose src isn't allowed) or at the document, and it bubbles, so the document hears all of them
document.addEventListener("securitypolicyviolation", (event) => {
	// Both policies: report-only reports are what TIDAL's policy would block, enforced ones what Luna's strict network
	// blocked (Settings > Network, "Blocked in the page")
	const kept = keepReport(cspReports, cspReportsDropped, maxReports, event);
	// Seen before: only counted, so a plugin polling a host doesn't flood the log
	if (kept === "seen") return;
	// Full: counted as dropped, warned about once
	if (kept === "dropped") {
		if (cspReportsDropped.count === 1) trace.warn(`CSP report-only: over ${maxReports} distinct reports, not logging more`);
		return;
	}
	// New: kept and logged once, Settings and luna.core.cspReports read the map
	if (kept.enforced) trace.warn(`CSP blocked: ${kept.directive} ${kept.blocked} (from ${kept.sourceFile})`);
	else trace.log(`CSP report-only: ${kept.directive} ${kept.blocked} (from ${kept.sourceFile})`);
});
