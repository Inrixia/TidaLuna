import assert from "node:assert";
import { describe, it } from "node:test";

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
		assert.deepEqual(keepReport(reports, dropped, 10, violation("https://evil.example/a?user=1")), {
			directive: "connect-src",
			blocked: "https://evil.example",
			sourceFile: "https://luna",
			count: 1,
			enforced: true,
		});
		assert.equal(keepReport(reports, dropped, 10, violation("https://evil.example/b")), "seen");
		assert.equal([...reports.values()][0].count, 2);
		// The same host only reported (not blocked) is a report of its own
		const reportOnly = keepReport(reports, dropped, 10, violation("https://evil.example/c", "report"));
		assert.equal(typeof reportOnly === "object" && reportOnly.enforced, undefined);
		assert.equal(reports.size, 2);
	});

	it("drops new reports once full, still counting the ones it has", () => {
		const reports = new Map<string, CspReport>();
		const dropped = { count: 0 };
		keepReport(reports, dropped, 1, violation("https://a.example/"));
		assert.equal(keepReport(reports, dropped, 1, violation("https://b.example/")), "dropped");
		assert.equal(keepReport(reports, dropped, 1, violation("https://a.example/")), "seen");
		assert.equal(dropped.count, 1);
		assert.equal(reports.size, 1);
	});

	it("reduces what it names to an origin, a scheme or a keyword", () => {
		assert.equal(originOf("https://cdn.example.com:8443/x?q"), "https://cdn.example.com:8443");
		assert.equal(originOf("data:image/png;base64,AAAA"), "data");
		assert.equal(originOf("inline"), "inline");
		assert.equal(originOf(""), "unknown");
	});
});
