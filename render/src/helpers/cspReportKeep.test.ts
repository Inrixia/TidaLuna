import { describe, expect, it } from "vitest";

import { keepReport, originOf, type CspReport, type Violation } from "./cspReportKeep";

const violation = (blockedURI: string, disposition: Violation["disposition"] = "enforce"): Violation => ({
	disposition,
	effectiveDirective: "connect-src",
	blockedURI,
	sourceFile: "https://luna/plugin.mjs",
});

describe("keepReport", () => {
	it("keeps one report per origin, counts the rest, and marks the enforced ones", () => {
		const reports = new Map<string, CspReport>();
		const dropped = { count: 0 };
		expect(keepReport(reports, dropped, 10, violation("https://evil.example/a?user=1"))).toEqual({
			directive: "connect-src",
			blocked: "https://evil.example",
			sourceFile: "https://luna",
			count: 1,
			enforced: true,
		});
		expect(keepReport(reports, dropped, 10, violation("https://evil.example/b"))).toBe("seen");
		expect([...reports.values()][0].count).toBe(2);
		// The same host only reported (not blocked) is a report of its own
		const reportOnly = keepReport(reports, dropped, 10, violation("https://evil.example/c", "report"));
		expect(typeof reportOnly === "object" && reportOnly.enforced).toBe(undefined);
		expect(reports.size).toBe(2);
	});

	it("drops new reports once full, still counting the ones it has", () => {
		const reports = new Map<string, CspReport>();
		const dropped = { count: 0 };
		keepReport(reports, dropped, 1, violation("https://a.example/"));
		expect(keepReport(reports, dropped, 1, violation("https://b.example/"))).toBe("dropped");
		expect(keepReport(reports, dropped, 1, violation("https://a.example/"))).toBe("seen");
		expect(dropped.count).toBe(1);
		expect(reports.size).toBe(1);
	});

	it("reduces what it names to an origin, a scheme or a keyword", () => {
		expect(originOf("https://cdn.example.com:8443/x?q")).toBe("https://cdn.example.com:8443");
		expect(originOf("data:image/png;base64,AAAA")).toBe("data");
		expect(originOf("inline")).toBe("inline");
		expect(originOf("")).toBe("unknown");
	});
});
