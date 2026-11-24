import { describe, expect, it } from "vitest";

import { hostAllowed, parseHostEntry } from "./core/hosts";
import { baselineEntries, enforcedPolicy, networkBaseline, reportOnlyHeader, reportOnlyPolicy, tidalMetaPolicy } from "./cspReportOnly";

// TIDAL 2.48.0's meta policy, copied from desktop.tidal.com on 2026-11-23. Kept here rather than fetched so the tests
// run offline and give the same result every time: a change on TIDAL's side shouldn't fail CI. The code reads whatever
// policy the live page has; this is a sample of its real shape (quotes, hashes, wildcard hosts, a trailing ";")
const tidal =
	"base-uri 'self'; object-src 'none'; script-src 'unsafe-inline' 'self' 'wasm-unsafe-eval' *.gstatic.com *.stripe.com *.tidal.com *.cookielaw.org blob:; style-src 'unsafe-inline' 'self' *.gstatic.com *.tidal.com *.cookielaw.org *.squarecdn.com sha256-0hAheEzaMe6uXIKV4EehS9pu1am1lj/KnnzrOYqckXk=; font-src data: *.squarecdn.com;";

const parse = (policy: string) => new Map(policy.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));

describe("tidalMetaPolicy", () => {
	it("reads the meta tag's content", () => {
		expect(tidalMetaPolicy(`<head><meta http-equiv="Content-Security-Policy" content="${tidal}" /></head>`)).toBe(tidal);
	});
	it("decodes html entities", () => {
		expect(tidalMetaPolicy(`<meta http-equiv="Content-Security-Policy" content="script-src &#39;self&#39; a.com?x=1&amp;y=2">`)).toBe(
			"script-src 'self' a.com?x=1&y=2",
		);
	});
	it("finds the tag whatever the attribute order", () => {
		expect(tidalMetaPolicy(`<meta content="object-src 'none'" http-equiv="Content-Security-Policy">`)).toBe("object-src 'none'");
	});
	it("is undefined without a policy", () => {
		expect(tidalMetaPolicy("<head><meta charset=utf-8></head>")).toBeUndefined();
		expect(tidalMetaPolicy(`<meta http-equiv="Content-Security-Policy">`)).toBeUndefined();
	});
});

describe("reportOnlyPolicy", () => {
	const policy = parse(reportOnlyPolicy(tidal));
	it("keeps TIDAL's directives", () => {
		expect(policy.get("object-src")).toEqual(["'none'"]);
		expect(policy.get("font-src")).toEqual(["data:", "*.squarecdn.com"]);
		expect(policy.get("style-src")?.includes("sha256-0hAheEzaMe6uXIKV4EehS9pu1am1lj/KnnzrOYqckXk=")).toBeTruthy();
	});
	it("adds Luna's script sources once", () => {
		const script = policy.get("script-src")!;
		expect(script.includes("https://luna") && script.includes("luna-module:") && script.includes("blob:")).toBeTruthy();
		const twice = parse(reportOnlyPolicy(reportOnlyPolicy(tidal))).get("script-src")!;
		expect(twice.filter((s) => s === "https://luna").length).toBe(1);
	});
	it("fills the network directives TIDAL leaves open", () => {
		for (const directive of ["connect-src", "img-src", "media-src", "frame-src"]) expect(policy.get(directive)).toEqual(networkBaseline);
	});
	it("doesn't override directives TIDAL sets, nor add any under default-src", () => {
		expect(parse(reportOnlyPolicy("connect-src 'self'")).get("connect-src")).toEqual(["'self'"]);
		expect([...parse(reportOnlyPolicy("default-src 'self'")).keys()]).toEqual(["default-src"]);
	});
	it("lists the hosts plugins declare where plugins fetch and show media, not in frame-src", () => {
		const withPlugins = parse(reportOnlyPolicy(tidal, ["https://api.last.fm", "wss://api.last.fm", "https://luna"]));
		for (const directive of ["connect-src", "img-src", "media-src"]) {
			const sources = withPlugins.get(directive)!;
			expect(sources.includes("https://api.last.fm") && sources.includes("wss://api.last.fm"), directive).toBeTruthy();
			expect(sources.filter((s) => s === "https://luna").length).toBe(1);
		}
		expect(withPlugins.get("frame-src")).toEqual(networkBaseline);
		expect(parse(reportOnlyPolicy("connect-src 'self'", ["https://a.com"])).get("connect-src")).toEqual(["'self'"]);
	});
	it("keeps the first of repeated directives, as browsers do", () => {
		expect(parse(reportOnlyPolicy("object-src 'none'; object-src *")).get("object-src")).toEqual(["'none'"]);
	});
	it("leaves script-src out when TIDAL has none", () => {
		expect(parse(reportOnlyPolicy("object-src 'none'")).has("script-src")).toBe(false);
	});
	it("drops directives a meta tag ignores but a header would apply", () => {
		const policy = parse(reportOnlyPolicy("object-src 'none'; report-uri https://csp.example/r; Report-To csp; frame-ancestors 'none'; sandbox"));
		expect([...policy.keys()].filter((d) => !["connect-src", "img-src", "media-src", "frame-src"].includes(d))).toEqual(["object-src"]);
	});

	it("reads only the policy's own tag, whatever comes before and after it", () => {
		const page = `<head>${"<script>x>1</script>".repeat(50)}<meta name="a" content="b"><meta http-equiv="Content-Security-Policy" content="object-src 'none'" /><meta content="c"></head>`;
		expect(tidalMetaPolicy(page)).toBe("object-src 'none'");
		expect(tidalMetaPolicy(`<meta http-equiv="Content-Security-Policy" content="object-src 'none'"`)).toBeUndefined();
		const markerInText = `<meta name="x" content="y"><script>const m = 'http-equiv="Content-Security-Policy"'</script><meta http-equiv="Content-Security-Policy" content="object-src 'none'">`;
		expect(tidalMetaPolicy(markerInText)).toBe("object-src 'none'");
	});

	it("normalizes spaces and keeps directives without sources", () => {
		expect(reportOnlyPolicy("default-src  'self'\t;  upgrade-insecure-requests ;")).toBe("default-src 'self'; upgrade-insecure-requests");
	});

	it("builds the header again only when TIDAL's policy changes", () => {
		const first = reportOnlyHeader(tidal);
		expect(first).toBe(reportOnlyPolicy(tidal));
		expect(reportOnlyHeader(tidal)).toBe(first);
		expect(reportOnlyHeader("object-src 'none'")).toBe(reportOnlyPolicy("object-src 'none'"));
		// Another set of plugin sources is another header, not the cached one
		const withPlugin = reportOnlyHeader("object-src 'none'", ["https://api.example.com"]);
		expect(withPlugin).toBe(reportOnlyPolicy("object-src 'none'", ["https://api.example.com"]));
		expect(withPlugin.includes("https://api.example.com")).toBeTruthy();
		expect(reportOnlyHeader("object-src 'none'")).toBe(reportOnlyPolicy("object-src 'none'"));
	});
});

describe("enforcedPolicy", () => {
	it("limits connect-src to the baseline and the plugins' hosts, and leaves media open by default", () => {
		const policy = enforcedPolicy(["https://api.example.com", "*.tidal.com"]);
		expect(policy).toBe(`connect-src ${[...networkBaseline, "https://api.example.com"].join(" ")}`);
		expect(policy.includes("img-src")).toBe(false);
	});
	it("gives page code the baseline's host entries only", () => {
		expect(baselineEntries.includes("*.tidal.com")).toBeTruthy();
		expect(baselineEntries.includes("api.github.com")).toBeTruthy();
		// Luna's own Supporters tab
		expect(baselineEntries.includes("sponsors.hug.rip")).toBeTruthy();
		expect(baselineEntries.includes("'self'")).toBe(false);
		expect(baselineEntries.includes("blob:")).toBe(false);
		expect(baselineEntries.includes("https://luna")).toBe(false);
		expect(baselineEntries.includes("wss://*.tidal.com")).toBe(false);
		// Every one is a host entry Luna takes: a public-suffix wildcard would match nothing
		for (const entry of baselineEntries) expect(parseHostEntry(entry), entry).toBeTruthy();
		expect(hostAllowed(baselineEntries, new URL("https://raw.githubusercontent.com/a/b/main/store.json"))).toBeTruthy();
	});
	it("lets TIDAL's push socket and Luna's MusicBrainz lookups through (seen blocked on a live slot)", () => {
		const sources = enforcedPolicy([]).split(" ");
		expect(sources.includes("wss://*.tidal.com")).toBeTruthy();
		expect(sources.includes("musicbrainz.org")).toBeTruthy();
	});
});
