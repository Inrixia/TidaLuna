// What cspReports.ts keeps of a securitypolicyviolation, without the page: tested on its own

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

/** The fields of a SecurityPolicyViolationEvent a report is made of */
export type Violation = Pick<SecurityPolicyViolationEvent, "disposition" | "effectiveDirective" | "blockedURI" | "sourceFile">;

/**
 * What a report names, reduced to an origin (`https://example.com`) so one host is one report whatever its paths and
 * queries (they can carry user data). URLs without an origin (`data:`, `blob:`) give their scheme, keywords stay as they are
 */
export const originOf = (uri: string) => {
	try {
		const url = new URL(uri);
		return url.origin !== "null" ? url.origin : url.protocol.slice(0, -1);
	} catch {
		// "inline", "eval", "wasm-eval" or empty
		return uri || "unknown";
	}
};

/**
 * Keeps `violation` in `reports` (keyed by disposition, directive, blocked and sourceFile): a report seen before is only
 * counted, one past `max` distinct reports only counts in `dropped`
 * @returns the new report, "seen" or "dropped"
 */
export const keepReport = (reports: Map<string, CspReport>, dropped: { count: number }, max: number, violation: Violation) => {
	const enforced = violation.disposition === "enforce";
	// effectiveDirective is the directive that applied (img-src, not default-src it fell back to)
	const blocked = originOf(violation.blockedURI);
	const sourceFile = originOf(violation.sourceFile);
	const key = `${enforced ? "enforce" : "report"} ${violation.effectiveDirective} ${blocked} ${sourceFile}`;
	const report = reports.get(key);
	if (report !== undefined) {
		report.count++;
		return "seen";
	}
	if (reports.size >= max) {
		dropped.count++;
		return "dropped";
	}
	const kept: CspReport = {
		directive: violation.effectiveDirective,
		blocked,
		sourceFile,
		count: 1,
		...(enforced ? { enforced: true as const } : {}),
	};
	reports.set(key, kept);
	return kept;
};
