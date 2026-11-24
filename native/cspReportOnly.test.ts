import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networkBaseline, reportOnlyHeader, reportOnlyPolicy, tidalMetaPolicy } from "./cspReportOnly";

// TIDAL 2.48.0's meta policy, copied from desktop.tidal.com on 2026-11-23. Kept here rather than fetched so the tests
// run offline and give the same result every time: a change on TIDAL's side shouldn't fail CI. The code reads whatever
// policy the live page has; this is a sample of its real shape (quotes, hashes, wildcard hosts, a trailing ";")
const tidal =
	"base-uri 'self'; object-src 'none'; script-src 'unsafe-inline' 'self' 'wasm-unsafe-eval' *.gstatic.com *.stripe.com *.tidal.com *.cookielaw.org blob:; style-src 'unsafe-inline' 'self' *.gstatic.com *.tidal.com *.cookielaw.org *.squarecdn.com sha256-0hAheEzaMe6uXIKV4EehS9pu1am1lj/KnnzrOYqckXk=; font-src data: *.squarecdn.com;";

const parse = (policy: string) => new Map(policy.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));

describe("tidalMetaPolicy", () => {
	it("reads the meta tag's content", () => {
		assert.equal(tidalMetaPolicy(`<head><meta http-equiv="Content-Security-Policy" content="${tidal}" /></head>`), tidal);
	});
	it("decodes html entities", () => {
		assert.equal(
			tidalMetaPolicy(`<meta http-equiv="Content-Security-Policy" content="script-src &#39;self&#39; a.com?x=1&amp;y=2">`),
			"script-src 'self' a.com?x=1&y=2",
		);
	});
	it("finds the tag whatever the attribute order", () => {
		assert.equal(tidalMetaPolicy(`<meta content="object-src 'none'" http-equiv="Content-Security-Policy">`), "object-src 'none'");
	});
	it("is undefined without a policy", () => {
		assert.equal(tidalMetaPolicy("<head><meta charset=utf-8></head>"), undefined);
		assert.equal(tidalMetaPolicy(`<meta http-equiv="Content-Security-Policy">`), undefined);
	});
});

describe("reportOnlyPolicy", () => {
	const policy = parse(reportOnlyPolicy(tidal));
	it("keeps TIDAL's directives", () => {
		assert.deepEqual(policy.get("object-src"), ["'none'"]);
		assert.deepEqual(policy.get("font-src"), ["data:", "*.squarecdn.com"]);
		assert.ok(policy.get("style-src")?.includes("sha256-0hAheEzaMe6uXIKV4EehS9pu1am1lj/KnnzrOYqckXk="));
	});
	it("adds Luna's script sources once", () => {
		const script = policy.get("script-src")!;
		assert.ok(script.includes("https://luna") && script.includes("luna-module:") && script.includes("blob:"));
		const twice = parse(reportOnlyPolicy(reportOnlyPolicy(tidal))).get("script-src")!;
		assert.equal(twice.filter((s) => s === "https://luna").length, 1);
	});
	it("fills the network directives TIDAL leaves open", () => {
		for (const directive of ["connect-src", "img-src", "media-src", "frame-src"]) assert.deepEqual(policy.get(directive), networkBaseline);
	});
	it("doesn't override directives TIDAL sets, nor add any under default-src", () => {
		assert.deepEqual(parse(reportOnlyPolicy("connect-src 'self'")).get("connect-src"), ["'self'"]);
		assert.deepEqual([...parse(reportOnlyPolicy("default-src 'self'")).keys()], ["default-src"]);
	});
	it("keeps the first of repeated directives, as browsers do", () => {
		assert.deepEqual(parse(reportOnlyPolicy("object-src 'none'; object-src *")).get("object-src"), ["'none'"]);
	});
	it("leaves script-src out when TIDAL has none", () => {
		assert.equal(parse(reportOnlyPolicy("object-src 'none'")).has("script-src"), false);
	});
	it("drops directives a meta tag ignores but a header would apply", () => {
		const policy = parse(reportOnlyPolicy("object-src 'none'; report-uri https://csp.example/r; Report-To csp; frame-ancestors 'none'; sandbox"));
		assert.deepEqual(
			[...policy.keys()].filter((d) => !["connect-src", "img-src", "media-src", "frame-src"].includes(d)),
			["object-src"],
		);
	});

	it("reads only the policy's own tag, whatever comes before and after it", () => {
		const page = `<head>${"<script>x>1</script>".repeat(50)}<meta name="a" content="b"><meta http-equiv="Content-Security-Policy" content="object-src 'none'" /><meta content="c"></head>`;
		assert.equal(tidalMetaPolicy(page), "object-src 'none'");
		assert.equal(tidalMetaPolicy(`<meta http-equiv="Content-Security-Policy" content="object-src 'none'"`), undefined);
		const markerInText = `<meta name="x" content="y"><script>const m = 'http-equiv="Content-Security-Policy"'</script><meta http-equiv="Content-Security-Policy" content="object-src 'none'">`;
		assert.equal(tidalMetaPolicy(markerInText), "object-src 'none'");
	});

	it("normalizes spaces and keeps directives without sources", () => {
		assert.equal(reportOnlyPolicy("default-src  'self'\t;  upgrade-insecure-requests ;"), "default-src 'self'; upgrade-insecure-requests");
	});

	it("builds the header again only when TIDAL's policy changes", () => {
		const first = reportOnlyHeader(tidal);
		assert.equal(first, reportOnlyPolicy(tidal));
		assert.strictEqual(reportOnlyHeader(tidal), first);
		assert.equal(reportOnlyHeader("object-src 'none'"), reportOnlyPolicy("object-src 'none'"));
	});
});
