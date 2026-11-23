// Run: pnpm exec tsx --test render/src/helpers/registry.test.ts
// Fixtures in registry.fixtures/ are signed with the registry's own scripts (luna-registry scripts/lib.mjs) and the TEST key
// whose public half is registryPublicKey. Their bytes are what is signed: don't reformat them (.gitattributes keeps line endings).
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
	acceptRegistryFile,
	asSentence,
	decodeServedCode,
	changedDependency,
	dependencyWaitMessage,
	dependsOnAny,
	keepsLiveReloading,
	legacyBomSha256,
	packageSha256s,
	parseRegistryFile,
	rawCodeOf,
	rawSha256,
	sameServedCode,
	registryBaseUrl,
	registryLoadDecision,
	registryPublicKey,
	replacesInUse,
	revocationAction,
	revokedEntryFor,
	unverifiedPlugins,
	verifiedEntryFor,
	versionToRestore,
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
	assert.throws(() => parseRegistryFile("verified.json", `{"schema":1,"kind":"verified","serial":-1,"entries":{}}`), /serial/);
	assert.throws(() => parseRegistryFile("verified.json", `{"schema":1,"kind":"verified","serial":1.5,"entries":{}}`), /serial/);
	assert.throws(() => parseRegistryFile("revoked.json", `{"schema":1,"kind":"revoked","serial":1}`), /entries/);
});

const sha = (char: string) => char.repeat(64);
const verified: VerifiedFile = parseRegistryFile(
	"verified.json",
	JSON.stringify({
		schema: 1,
		kind: "verified",
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
		kind: "revoked",
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
	assert.throws(() => registryBaseUrl("http://127.0.0.1:3002/registry/?v=1"), /query/);
	assert.throws(() => registryBaseUrl("http://127.0.0.1:3002/registry/#x"), /query/);
});

test("a list in use is replaced by the same or a higher serial, not a lower one", () => {
	assert.equal(replacesInUse(undefined, { serial: 1 }), true);
	assert.equal(replacesInUse({ serial: 2 }, { serial: 2 }), true);
	assert.equal(replacesInUse({ serial: 2 }, { serial: 3 }), true);
	assert.equal(replacesInUse({ serial: 2 }, { serial: 1 }), false);
});

test("verified entries in the current format: path, build, out and a commit url report are kept", () => {
	const sha = "a".repeat(64);
	const entry = {
		id: "test.p",
		name: "P",
		repo: "https://github.com/Inrixia/luna-plugins",
		commit: "0".repeat(40),
		path: "plugins/P",
		build: "pnpm build",
		out: "dist",
		natives: {},
		capabilities: [],
		report: `https://github.com/Inrixia/luna-registry/commit/${"1".repeat(40)}`,
		verifiedAt: "2026-11-23T12:00:00.000Z",
		sig: "x",
	};
	const file = parseRegistryFile("verified.json", JSON.stringify({ schema: 1, kind: "verified", serial: 1, entries: { [sha]: entry } }));
	assert.deepEqual(file.entries[sha], entry);
});

test("revocation reasons end in one full stop", () => {
	assert.equal(asSentence("Steals tokens"), "Steals tokens.");
	assert.equal(asSentence("Steals tokens."), "Steals tokens.");
	assert.equal(asSentence("Mines crypto!"), "Mines crypto!");
	assert.equal(asSentence("Steals tokens "), "Steals tokens.");
	assert.equal(asSentence('Says "hi."'), 'Says "hi."');
	assert.equal(asSentence("(see report.)"), "(see report.)");
});

test("a new revoked.json stops running revoked plugins and loads again the ones whose revocation was lifted", async () => {
	const revoked = <RevokedFile>parseRegistryFile("revoked.json", new TextDecoder().decode(fixture("revoked.json")));
	const plugin = { url: "https://example.com/P", loaded: true, stoppedByRevocation: false, enabled: true };
	// Running revoked code stops; revoked code that isn't running (still loading, or already stopped) is left to loadExports
	assert.equal(revocationAction({ ...plugin, rawSha256: codes.sha256.revoked }, revoked).action, "stop");
	assert.equal(revocationAction({ ...plugin, rawSha256: codes.sha256.revoked, loaded: false }, revoked).action, "none");
	// Stopped by a revocation that is gone: loads again, unless disabled
	const stopped = { ...plugin, rawSha256: codes.sha256.revoked, loaded: false, stoppedByRevocation: true };
	assert.equal(revocationAction(stopped, undefined).action, "load");
	assert.equal(revocationAction({ ...stopped, enabled: false }, undefined).action, "none");
	assert.equal(revocationAction({ ...plugin, rawSha256: codes.sha256.verified }, revoked).action, "none");
	// Luna's own plugins are never revoked
	assert.equal(revocationAction({ ...plugin, url: "https://luna/luna.lib", rawSha256: codes.sha256.revoked }, revoked).action, "none");
});

test("served code keeps a BOM and refuses invalid UTF-8, so its raw sha256 is the sha256 of the file's bytes", async () => {
	const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(codes.revoked)]);
	assert.equal(await rawSha256(decodeServedCode(withBom)), createHash("sha256").update(withBom).digest("hex"));
	assert.notEqual(await rawSha256(decodeServedCode(withBom)), codes.sha256.revoked);
	assert.equal(await rawSha256(decodeServedCode(new TextEncoder().encode(codes.revoked))), codes.sha256.revoked);
	assert.throws(() => decodeServedCode(new Uint8Array([0x2f, 0x2f, 0xff, 0x0a])), /not valid UTF-8/);
});

test("a signed file served as the other file, or without kind, is rejected", async () => {
	// revoked.json is validly signed, but its kind says what it is
	const asVerified = await acceptRegistryFile("verified.json", signed("revoked.json"));
	assert.equal(asVerified.ok, false);
	assert.match(!asVerified.ok ? asVerified.reason : "", /kind "revoked", expected "verified"/);
	const asRevoked = await acceptRegistryFile("revoked.json", signed("verified.json"));
	assert.equal(asRevoked.ok, false);
	assert.match(!asRevoked.ok ? asRevoked.reason : "", /kind "verified", expected "revoked"/);
	const noKind = await acceptRegistryFile("revoked.json", signed("nokind.json"));
	assert.equal(noKind.ok, false);
	assert.match(!noKind.ok ? noKind.reason : "", /kind undefined/);
	// The right file is accepted and keeps its kind
	const ok = await acceptRegistryFile("revoked.json", signed("revoked.json"));
	assert.equal(ok.ok && ok.file.kind, "revoked");
});

test("code stored before exact fetching matches its refetch only when it differs by a BOM", () => {
	const url = "https://example.com/Plugin";
	const stored = `export const a = 1;\n//# sourceURL=${url}.mjs`;
	assert.equal(sameServedCode(stored, `﻿export const a = 1;\n//# sourceURL=${url}.mjs`), true);
	assert.equal(sameServedCode(stored, `export const a = 1;\n//# sourceURL=${url}2.mjs`), true);
	assert.equal(sameServedCode(stored, `export const a = 2;\n//# sourceURL=${url}.mjs`), false);
});

test("code stored before exact fetching is looked up by both keys it may have (a BOM dropped or not)", async () => {
	const text = "export const x = 1;";
	const stored = `${text}\n//# sourceURL=https://example.com/X.mjs`;
	const withBom = createHash("sha256")
		.update(Buffer.from(`\uFEFF${text}`, "utf8"))
		.digest("hex");
	assert.equal(await legacyBomSha256(stored), withBom);
	// A text that starts with a BOM (the file had two) or has U+FFFD (a literal one) may still have lost a BOM
	const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
	assert.equal(await legacyBomSha256(`\uFEFF${text}`), sha(`\uFEFF\uFEFF${text}`));
	assert.equal(await legacyBomSha256(`${text}"\uFFFD"`), sha(`\uFEFF${text}"\uFFFD"`));

	const plain = await rawSha256(stored);
	const keys = packageSha256s({ rawSha256: plain, bomRawSha256: withBom });
	assert.deepEqual(keys, [plain, withBom]);
	assert.equal(packageSha256s({ rawSha256: plain }), plain);
	assert.equal(packageSha256s(undefined), undefined);

	const file = <T>(kind: "verified" | "revoked", entries: Record<string, T>) => ({ schema: 1 as const, kind, serial: 1, entries });
	const revoked = <RevokedFile>file("revoked", { [withBom]: { reason: "Bad" } });
	assert.equal(revokedEntryFor(revoked, keys)?.reason, "Bad");
	assert.equal(revokedEntryFor(revoked, plain), undefined);
	assert.equal(registryLoadDecision({ url: "https://example.com/X", rawSha256: keys }, revoked).load, false);
	const verified = <VerifiedFile>file("verified", { [withBom]: { id: "x", name: "X" } });
	assert.equal(verifiedEntryFor(verified, keys, "X")?.id, "x");
	assert.equal(verifiedEntryFor(verified, keys, "Y"), undefined);
	assert.equal(verifiedEntryFor(verified, [undefined, undefined], "X"), undefined);
	assert.deepEqual(
		unverifiedPlugins([{ url: "https://example.com/X", name: "X", installed: true, enabled: true, rawSha256: keys }], verified, undefined),
		[],
	);
});

test("a revoked accepted update gives back the version it replaced, only while it is the code the plugin has", () => {
	const previous = { rawSha256: sha("a"), version: "1" };
	const replaced = { rawSha256: sha("b"), previous };
	assert.equal(versionToRestore(replaced, { rawSha256: sha("b") }), previous);
	// Other code now (dev reload, a newer update): nothing to restore
	assert.equal(versionToRestore(replaced, { rawSha256: sha("c") }), undefined);
	assert.equal(versionToRestore(replaced, { rawSha256: undefined }), undefined);
	assert.equal(versionToRestore(replaced, undefined), undefined);
	assert.equal(versionToRestore(undefined, { rawSha256: sha("b") }), undefined);
});

test("live reload stops while the plugin's code is revoked", () => {
	assert.equal(keepsLiveReloading({ enabled: true, liveReload: true, revoked: false }), true);
	assert.equal(keepsLiveReloading({ enabled: true, liveReload: true, revoked: true }), false);
	assert.equal(keepsLiveReloading({ enabled: false, liveReload: true, revoked: false }), false);
	assert.equal(keepsLiveReloading({ enabled: true, liveReload: false, revoked: false }), false);
});

test("dependants of another revoked plugin stopping are found, through other plugins and cycles", () => {
	type Node = { name: string; dependants: Set<Node> };
	const node = (name: string): Node => ({ name, dependants: new Set() });
	const [a, b, c, d] = ["a", "b", "c", "d"].map(node);
	// b depends on a, c on b; d on nothing
	a.dependants.add(b);
	b.dependants.add(c);
	assert.equal(dependsOnAny(b, [a, b]), true);
	assert.equal(dependsOnAny(c, [a, c]), true);
	assert.equal(dependsOnAny(a, [a, b, c]), false);
	assert.equal(dependsOnAny(d, [a, b, c, d]), false);
	assert.equal(dependsOnAny(b, [b]), false);
	// A cycle doesn't loop
	c.dependants.add(a);
	assert.equal(dependsOnAny(d, [a]), false);
});

test("a dependency that changed while a plugin loaded is found, whichever way it changed", () => {
	type State = { unloadCount: number; unloading: boolean; loaded: boolean };
	const states = new Map<string, State>();
	const stateOf = (name: string) => states.get(name)!;
	const set = (name: string, state: State) => states.set(name, state);
	// Recorded when the import took their exports: a at 2 unloads, b at 0
	const imported = new Map([
		["a", 2],
		["b", 0],
	]);
	set("a", { unloadCount: 2, unloading: false, loaded: true });
	set("b", { unloadCount: 0, unloading: false, loaded: true });
	assert.equal(changedDependency(imported, stateOf), undefined);
	// Revoked or disabled: unloaded since
	set("b", { unloadCount: 1, unloading: false, loaded: false });
	assert.equal(changedDependency(imported, stateOf), "b");
	// Reloaded since: loaded again, but not the exports the import took
	set("b", { unloadCount: 1, unloading: false, loaded: true });
	assert.equal(changedDependency(imported, stateOf), "b");
	// Still unloading: exports still there, count not moved yet
	set("b", { unloadCount: 0, unloading: true, loaded: true });
	assert.equal(changedDependency(imported, stateOf), "b");
	// Not loaded without an unload counted (never loaded)
	set("b", { unloadCount: 0, unloading: false, loaded: false });
	assert.equal(changedDependency(imported, stateOf), "b");
	// A plugin it doesn't import changing is not its concern
	set("b", { unloadCount: 0, unloading: false, loaded: true });
	states.set("c", { unloadCount: 5, unloading: true, loaded: false });
	assert.equal(changedDependency(imported, stateOf), undefined);
	assert.equal(changedDependency(new Map(), stateOf), undefined);
});

test("the card says why a plugin waits for a dependency", () => {
	assert.match(dependencyWaitMessage({ name: "X", revoked: true, pending: true })!, /depends on X, which the Luna plugin registry revoked/);
	assert.equal(dependencyWaitMessage({ name: "X", revoked: false, pending: true }), undefined);
	assert.match(dependencyWaitMessage({ name: "X", revoked: false, pending: false })!, /depends on X, which is not loaded/);
});
