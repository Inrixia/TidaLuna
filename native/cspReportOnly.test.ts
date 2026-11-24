import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hostAllowed, parseHostEntry } from "./core/hosts";
import { baselineEntries, enforcedPolicy, networkBaseline, reportOnlyPolicy, tidalMetaPolicy } from "./cspReportOnly";

// TIDAL 2.48.0's meta policy (desktop.tidal.com, 2026-11-23)
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
	it("lists the hosts plugins declare where plugins fetch and show media, not in frame-src", () => {
		const withPlugins = parse(reportOnlyPolicy(tidal, ["https://api.last.fm", "wss://api.last.fm", "https://luna"]));
		for (const directive of ["connect-src", "img-src", "media-src"]) {
			const sources = withPlugins.get(directive)!;
			assert.ok(sources.includes("https://api.last.fm") && sources.includes("wss://api.last.fm"), directive);
			assert.equal(sources.filter((s) => s === "https://luna").length, 1);
		}
		assert.deepEqual(withPlugins.get("frame-src"), networkBaseline);
		assert.deepEqual(parse(reportOnlyPolicy("connect-src 'self'", ["https://a.com"])).get("connect-src"), ["'self'"]);
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
});

describe("enforcedPolicy", () => {
	it("limits connect-src to the baseline and the plugins' hosts, and leaves media open by default", () => {
		const policy = enforcedPolicy(["https://api.example.com", "*.tidal.com"]);
		assert.equal(policy, `connect-src ${[...networkBaseline, "https://api.example.com"].join(" ")}`);
		assert.equal(policy.includes("img-src"), false);
	});
	it("gives page code the baseline's host entries only", () => {
		assert.ok(baselineEntries.includes("*.tidal.com"));
		assert.ok(baselineEntries.includes("api.github.com"));
		assert.equal(baselineEntries.includes("'self'"), false);
		assert.equal(baselineEntries.includes("blob:"), false);
		assert.equal(baselineEntries.includes("https://luna"), false);
		assert.equal(baselineEntries.includes("wss://*.tidal.com"), false);
		// Every one is a host entry Luna takes: a public-suffix wildcard would match nothing
		for (const entry of baselineEntries) assert.ok(parseHostEntry(entry), entry);
		assert.ok(hostAllowed(baselineEntries, new URL("https://raw.githubusercontent.com/a/b/main/store.json")));
	});
	it("lets TIDAL's push socket and Luna's MusicBrainz lookups through (seen blocked on a live slot)", () => {
		const sources = enforcedPolicy([]).split(" ");
		assert.ok(sources.includes("wss://*.tidal.com"));
		assert.ok(sources.includes("musicbrainz.org"));
	});
});
