// Run: pnpm exec tsx --test render/src/helpers/registry.test.ts
// Fixtures in registry.fixtures/ are signed with the registry's own scripts (luna-registry scripts/lib.mjs) and the TEST key
// whose public half is registryPublicKey. Their bytes are what is signed: don't reformat them (.gitattributes keeps line endings).
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
	acceptRegistryFile,
	parseRegistryFile,
	rawCodeOf,
	rawSha256,
	registryBaseUrl,
	registryLoadDecision,
	registryPublicKey,
	revokedEntryFor,
	unverifiedPlugins,
	verifiedEntryFor,
	verifySignature,
	type RevokedFile,
	type VerifiedFile,
} from "./registry";
import { codeToImport, sha256Hex } from "./pluginUpdates";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./registry.fixtures/${name}`, import.meta.url)));
const signed = (name: string) => ({ bytes: fixture(name), signature: new TextDecoder().decode(fixture(`${name}.sig`)) });
const codes: { verified: string; revoked: string; sha256: { verified: string; revoked: string } } = JSON.parse(
	new TextDecoder().decode(fixture("codes.json")),
);

/** Another ed25519 key: what a file signed by someone else looks like to the client */
const otherPublicKey = () => {
	const { publicKey } = generateKeyPairSync("ed25519");
	return Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("base64");
};

test("a file signed by the registry key verifies", async () => {
	const { bytes, signature } = signed("verified.json");
	assert.equal(await verifySignature(bytes, signature, registryPublicKey), true);
	assert.equal(await verifySignature(signed("revoked.json").bytes, signed("revoked.json").signature), true);
});

test("a changed byte, another file's signature or a malformed signature don't verify", async () => {
	const { bytes, signature } = signed("verified.json");
	const changed = bytes.slice();
	changed[changed.length - 2] ^= 1;
	assert.equal(await verifySignature(changed, signature), false);
	assert.equal(await verifySignature(bytes, signed("revoked.json").signature), false);
	assert.equal(await verifySignature(bytes, "not base64!"), false);
	assert.equal(await verifySignature(bytes, ""), false);
	// Line endings changed (e.g. by git on Windows) also break it
	const crlf = new TextEncoder().encode(new TextDecoder().decode(bytes).replaceAll("\n", "\r\n"));
	assert.equal(await verifySignature(crlf, signature), false);
});

test("a signature by another key doesn't verify, nor a malformed key", async () => {
	const { bytes, signature } = signed("verified.json");
	assert.equal(await verifySignature(bytes, signature, otherPublicKey()), false);
	assert.equal(await verifySignature(bytes, signature, "AAAA"), false);
	assert.equal((await acceptRegistryFile("verified.json", signed("verified.json"), undefined, otherPublicKey())).ok, false);
});

test("accepts a signed file and parses it", async () => {
	const result = await acceptRegistryFile("verified.json", signed("verified.json"));
	assert.ok(result.ok);
	assert.equal(result.file.serial, 3);
	assert.equal(verifiedEntryFor(result.file, codes.sha256.verified, "Fixture")?.report, "https://github.com/Inrixia/luna-registry/pull/7");
});

test("rejects a file whose serial is lower than the highest accepted, accepts the same or a higher one", async () => {
	const old = signed("revoked-serial1.json");
	const rolledBack = await acceptRegistryFile("revoked.json", old, 2);
	assert.equal(rolledBack.ok, false);
	assert.match(!rolledBack.ok ? rolledBack.reason : "", /serial 1 is lower than 2/);
	assert.equal((await acceptRegistryFile("revoked.json", signed("revoked.json"), 2)).ok, true);
	assert.equal((await acceptRegistryFile("revoked.json", signed("revoked.json"), 1)).ok, true);
	assert.equal((await acceptRegistryFile("revoked.json", old, undefined)).ok, true);
});

test("rejects signed bytes that are not a registry file", async () => {
	// Signature checked first: a bad signature is reported as such, whatever the content
	const notJson = { bytes: new TextEncoder().encode("nope"), signature: signed("verified.json").signature };
	assert.deepEqual(await acceptRegistryFile("verified.json", notJson), { ok: false, reason: "verified.json: the signature does not verify" });
	assert.throws(() => parseRegistryFile("verified.json", "[]"), /not an object/);
	assert.throws(() => parseRegistryFile("verified.json", `{"schema":2,"serial":1,"entries":{}}`), /schema 2/);
	assert.throws(() => parseRegistryFile("verified.json", `{"schema":1,"serial":-1,"entries":{}}`), /serial/);
	assert.throws(() => parseRegistryFile("verified.json", `{"schema":1,"serial":1.5,"entries":{}}`), /serial/);
	assert.throws(() => parseRegistryFile("revoked.json", `{"schema":1,"serial":1}`), /entries/);
});

const sha = (char: string) => char.repeat(64);
const verified: VerifiedFile = parseRegistryFile(
	"verified.json",
	JSON.stringify({
		schema: 1,
		serial: 1,
		entries: {
			[sha("a")]: { id: "x.avatar", name: "Avatar", report: "https://github.com/Inrixia/luna-registry/pull/3" },
			[sha("b")]: { id: "x.evil", name: "Evil", report: "javascript:alert(1)" },
			[sha("c")]: { id: "x.noname" },
			"not-a-sha": { id: "x.bad", name: "Bad" },
			["__proto__"]: { name: "Avatar" },
		},
	}),
);
const revoked: RevokedFile = parseRegistryFile(
	"revoked.json",
	JSON.stringify({
		schema: 1,
		serial: 1,
		entries: { [sha("d")]: { id: "x.avatar", reason: "Steals tokens", report: "https://r/1" }, [sha("e")]: null },
	}),
);

test("verified lookup needs the sha256 key and the plugin's name", () => {
	assert.equal(verifiedEntryFor(verified, sha("a"), "Avatar")?.id, "x.avatar");
	// A verified build lends its badge to no other name
	assert.equal(verifiedEntryFor(verified, sha("a"), "Other"), undefined);
	assert.equal(verifiedEntryFor(verified, sha("f"), "Avatar"), undefined);
	assert.equal(verifiedEntryFor(verified, undefined, "Avatar"), undefined);
	assert.equal(verifiedEntryFor(undefined, sha("a"), "Avatar"), undefined);
	// Entries without a name and keys that are not a sha256 are dropped, prototype keys are never entries
	assert.equal(verifiedEntryFor(verified, sha("c"), ""), undefined);
	assert.deepEqual(Object.keys(verified.entries).sort(), [sha("a"), sha("b")]);
	assert.equal(verifiedEntryFor(verified, "__proto__", "Avatar"), undefined);
	assert.equal(verifiedEntryFor(verified, "constructor", "Object"), undefined);
	// Only http(s) report links
	assert.equal(verified.entries[sha("b")].report, undefined);
});

test("revoked lookup by sha256; any listed sha256 is revoked, even with a malformed entry", () => {
	assert.equal(revokedEntryFor(revoked, sha("d"))?.reason, "Steals tokens");
	assert.equal(revokedEntryFor(revoked, sha("e"))?.reason, "No reason given");
	assert.equal(revokedEntryFor(revoked, sha("a")), undefined);
	assert.equal(revokedEntryFor(revoked, undefined), undefined);
	assert.equal(revokedEntryFor(undefined, sha("d")), undefined);
	assert.equal(revokedEntryFor(revoked, "toString"), undefined);
});

test("the raw sha256 is the sha256 of the served .mjs, whatever url serves it", async () => {
	// What the registry computed for the fixture code (sha256 of the file's bytes)
	const url = "https://example.com/Fixture";
	const stored = `${codes.verified}\n//# sourceURL=${url}.mjs`;
	assert.equal(rawCodeOf(stored), codes.verified);
	assert.equal(await rawSha256(stored), codes.sha256.verified);
	// Same file from another url: same raw sha256, different codeSha256
	const elsewhere = `${codes.verified}\n//# sourceURL=https://other.example/Fixture.mjs`;
	assert.equal(await rawSha256(elsewhere), codes.sha256.verified);
	const native = `__ipcRenderer.invoke("__Luna.registerNative", "a.native.ts", "");`;
	const a = `${native}\n//# sourceURL=https://a/P.mjs`;
	const b = `${native}\n//# sourceURL=https://b/P.mjs`;
	assert.equal(await rawSha256(a), await rawSha256(b));
	assert.notEqual(await sha256Hex(codeToImport(a, "https://a/P")), await sha256Hex(codeToImport(b, "https://b/P")));
	// Only Luna's own suffix is removed: one line, at the very end
	assert.equal(rawCodeOf("a\n//# sourceURL=x.mjs\nb\n//# sourceURL=y.mjs"), "a\n//# sourceURL=x.mjs\nb");
	assert.equal(rawCodeOf("no suffix"), "no suffix");
});

test("revoked code does not load; core plugins are never revoked; dev plugins are checked", () => {
	assert.deepEqual(registryLoadDecision({ url: "https://example.com/Avatar", rawSha256: sha("a") }, revoked), { load: true });
	const decision = registryLoadDecision({ url: "https://example.com/Avatar", rawSha256: sha("d") }, revoked);
	assert.equal(decision.load, false);
	assert.equal(!decision.load && decision.revoked.reason, "Steals tokens");
	assert.equal(registryLoadDecision({ url: "http://127.0.0.1:3002/Avatar", rawSha256: sha("d") }, revoked).load, false);
	assert.equal(registryLoadDecision({ url: "https://luna/luna.lib", rawSha256: sha("d") }, revoked).load, true);
	// No list (fetch failed, nothing cached) or no hash yet: plugins load
	assert.equal(registryLoadDecision({ url: "https://example.com/Avatar", rawSha256: sha("d") }, undefined).load, true);
	assert.equal(registryLoadDecision({ url: "https://example.com/Avatar", rawSha256: undefined }, revoked).load, true);
});

test("counts enabled plugins without a verified entry, dev included, core and revoked left out", () => {
	const plugin = (name: string, rawSha256: string | undefined, more: Partial<{ url: string; installed: boolean; enabled: boolean }> = {}) => ({
		name,
		rawSha256,
		url: `https://example.com/${name}`,
		installed: true,
		enabled: true,
		...more,
	});
	const plugins = [
		plugin("Avatar", sha("a")),
		plugin("Unlisted", sha("f")),
		plugin("Renamed", sha("a")),
		plugin("Dev", sha("a"), { url: "http://127.0.0.1:3002/Dev" }),
		plugin("Disabled", sha("f"), { enabled: false }),
		plugin("Uninstalled", sha("f"), { installed: false }),
		plugin("@luna/ui", undefined, { url: "https://luna/luna.ui" }),
		plugin("Revoked", sha("d")),
		plugin("NotLoadedYet", undefined),
	];
	assert.deepEqual(
		unverifiedPlugins(plugins, verified, revoked).map((p) => p.name),
		["Unlisted", "Renamed", "Dev", "NotLoadedYet"],
	);
	// Without a verified list every enabled non-core plugin is unverified
	assert.equal(unverifiedPlugins(plugins, undefined, undefined).length, 6);
});

test("registry base url: https or a local http server, always ending with /", () => {
	assert.equal(registryBaseUrl(), "https://raw.githubusercontent.com/Inrixia/luna-registry/signed/");
	assert.equal(registryBaseUrl("http://127.0.0.1:3002/registry"), "http://127.0.0.1:3002/registry/");
	assert.equal(registryBaseUrl("http://localhost:3002/registry/"), "http://localhost:3002/registry/");
	assert.throws(() => registryBaseUrl("http://example.com/registry/"), /https/);
	assert.throws(() => registryBaseUrl("http://127.0.0.1.example.com/"), /https/);
	assert.throws(() => registryBaseUrl("file:///C:/registry/"), /https/);
});
