import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * `cspReports` collects what the report-only policy (native/cspReportOnly.ts) reports, so the log shows which hosts TIDAL
 * and plugins really use before anything is enforced. Everything happens through the `securitypolicyviolation` listener
 * this module registers on the document, so the tests dispatch that event the way the browser does.
 *
 * `./trace` is mocked: `Tracer` binds `console.log`/`console.warn` when it is created, so a spy placed afterwards would
 * never see these calls, and the warn-once rule is worth asserting rather than just executing.
 */
const trace = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn() }));
vi.mock("./trace", () => ({ coreTrace: { withSource: () => ({ trace }) } }));

import { cspReports, cspReportsDropped } from "./cspReports";

/** Dispatch a violation at the document. Defaults are a report-only img-src violation from a Luna fetch */
const violation = (init: Partial<{ disposition: string; effectiveDirective: string; blockedURI: string; sourceFile: string }> = {}) => {
	const event = new Event("securitypolicyviolation");
	Object.assign(event, {
		disposition: "report",
		effectiveDirective: "img-src",
		blockedURI: "https://cdn.example.com/a.png?token=secret",
		sourceFile: "https://luna/lib.mjs",
		...init,
	});
	document.dispatchEvent(event);
};

/** The single report kept, or undefined */
const only = () => [...cspReports.values()][0];

beforeEach(() => {
	cspReports.clear();
	cspReportsDropped.count = 0;
	trace.log.mockClear();
	trace.warn.mockClear();
});

describe("cspReports", () => {
	test("keeps a report as the origin it names, without the path or query", () => {
		violation();

		// The query can carry user data, so only the origin is kept: one host is one report whatever it was asked for
		expect(only()).toEqual({ directive: "img-src", blocked: "https://cdn.example.com", sourceFile: "https://luna", count: 1 });
		expect(trace.log).toHaveBeenCalledWith("CSP report-only: img-src https://cdn.example.com (from https://luna)");
	});

	test("ignores a violation the browser enforced rather than reported", () => {
		// An enforced policy blocked the request: that is TIDAL's business, not what this log maps
		violation({ disposition: "enforce" });

		expect(cspReports.size).toBe(0);
		expect(trace.log).not.toHaveBeenCalled();
	});

	test("counts a repeat of the same report instead of keeping another", () => {
		violation();
		violation();
		violation();

		expect(cspReports.size).toBe(1);
		expect(only()?.count).toBe(3);
		// Logged when it was new, not once per repeat
		expect(trace.log).toHaveBeenCalledTimes(1);
	});

	test("keeps reports that differ by directive or by the script they name", () => {
		violation();
		violation({ effectiveDirective: "connect-src" });
		// Another origin: a different path on the same one reduces to the same origin, so it is the same report
		violation({ sourceFile: "https://other.example/app.mjs" });
		violation({ sourceFile: "https://luna/other.mjs" });

		expect(cspReports.size).toBe(3);
		expect([...cspReports.keys()]).toEqual([
			"img-src https://cdn.example.com https://luna",
			"connect-src https://cdn.example.com https://luna",
			"img-src https://cdn.example.com https://other.example",
		]);
		// The same origin under another path counted against the first report instead of being kept apart
		expect(cspReports.get("img-src https://cdn.example.com https://luna")?.count).toBe(2);
	});

	test("reduces each kind of blocked uri to what names it", () => {
		// A keyword (inline, eval) and an empty blockedURI are not urls: kept as they are, empty as unknown
		violation({ blockedURI: "inline" });
		violation({ blockedURI: "" });
		// No origin, so its scheme names it
		violation({ blockedURI: "data:image/png;base64,AAAA" });

		expect([...cspReports.values()].map((report) => report.blocked)).toEqual(["inline", "unknown", "data"]);
	});

	test("stops keeping new reports once full, counting them as dropped", () => {
		for (let i = 0; i < 500; i++) violation({ blockedURI: `https://host${i}.example.com/` });
		expect(cspReports.size).toBe(500);
		expect(cspReportsDropped.count).toBe(0);

		// A plugin hitting random subdomains must not grow the map (and the log) forever
		violation({ blockedURI: "https://overflow.example.com/" });
		violation({ blockedURI: "https://overflow2.example.com/" });

		expect(cspReports.size).toBe(500);
		expect(cspReportsDropped.count).toBe(2);
		// Warned about once, not once per dropped report
		expect(trace.warn).toHaveBeenCalledTimes(1);
		expect(trace.warn).toHaveBeenCalledWith("CSP report-only: over 500 distinct reports, not logging more");
	});
});
