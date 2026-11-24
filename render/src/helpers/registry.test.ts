// Fixtures in registry.fixtures/ are signed with the registry's own scripts (luna-registry scripts/lib.mjs) and the TEST key
// whose public half is registryPublicKey. Their bytes are what is signed: don't reformat them (.gitattributes keeps line endings).
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

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

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(process.cwd(), "render/src/helpers/registry.fixtures", name)));
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
	expect(await verifySignature(bytes, signature, registryPublicKey)).toBe(true);
	expect(await verifySignature(signed("revoked.json").bytes, signed("revoked.json").signature)).toBe(true);
});

test("a changed byte, another file's signature or a malformed signature don't verify", async () => {
	const { bytes, signature } = signed("verified.json");
	const changed = bytes.slice();
	changed[changed.length - 2] ^= 1;
	expect(await verifySignature(changed, signature)).toBe(false);
	expect(await verifySignature(bytes, signed("revoked.json").signature)).toBe(false);
	expect(await verifySignature(bytes, "not base64!")).toBe(false);
	expect(await verifySignature(bytes, "")).toBe(false);
	// Line endings changed (e.g. by git on Windows) also break it
	const crlf = new TextEncoder().encode(new TextDecoder().decode(bytes).replaceAll("\n", "\r\n"));
	expect(await verifySignature(crlf, signature)).toBe(false);
});

test("a signature by another key doesn't verify, nor a malformed key", async () => {
	const { bytes, signature } = signed("verified.json");
	expect(await verifySignature(bytes, signature, otherPublicKey())).toBe(false);
	expect(await verifySignature(bytes, signature, "AAAA")).toBe(false);
	expect((await acceptRegistryFile("verified.json", signed("verified.json"), undefined, otherPublicKey())).ok).toBe(false);
});

test("accepts a signed file and parses it", async () => {
	const result = await acceptRegistryFile("verified.json", signed("verified.json"));
	// Narrows the result for the lines below, and says why it was refused if it was
	if (!result.ok) throw new Error(`not accepted: ${result.reason}`);
	expect(result.file.serial).toBe(3);
	expect(verifiedEntryFor(result.file, codes.sha256.verified, "Fixture")?.report).toBe("https://github.com/Inrixia/luna-registry/pull/7");
});

test("rejects a file whose serial is lower than the highest accepted, accepts the same or a higher one", async () => {
	const old = signed("revoked-serial1.json");
	const rolledBack = await acceptRegistryFile("revoked.json", old, 2);
	expect(rolledBack.ok).toBe(false);
	expect(!rolledBack.ok ? rolledBack.reason : "").toMatch(/serial 1 is lower than 2/);
	expect((await acceptRegistryFile("revoked.json", signed("revoked.json"), 2)).ok).toBe(true);
	expect((await acceptRegistryFile("revoked.json", signed("revoked.json"), 1)).ok).toBe(true);
	expect((await acceptRegistryFile("revoked.json", old, undefined)).ok).toBe(true);
});

test("rejects signed bytes that are not a registry file", async () => {
	// Signature checked first: a bad signature is reported as such, whatever the content
	const notJson = { bytes: new TextEncoder().encode("nope"), signature: signed("verified.json").signature };
	expect(await acceptRegistryFile("verified.json", notJson)).toStrictEqual({ ok: false, reason: "verified.json: the signature does not verify" });
	expect(() => parseRegistryFile("verified.json", "[]")).toThrow(/not an object/);
	expect(() => parseRegistryFile("verified.json", `{"schema":2,"serial":1,"entries":{}}`)).toThrow(/schema 2/);
	expect(() => parseRegistryFile("verified.json", `{"schema":1,"kind":"verified","serial":-1,"entries":{}}`)).toThrow(/serial/);
	expect(() => parseRegistryFile("verified.json", `{"schema":1,"kind":"verified","serial":1.5,"entries":{}}`)).toThrow(/serial/);
	expect(() => parseRegistryFile("revoked.json", `{"schema":1,"kind":"revoked","serial":1}`)).toThrow(/entries/);
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
	expect(verifiedEntryFor(verified, sha("a"), "Avatar")?.id).toBe("x.avatar");
	// A verified build lends its badge to no other name
	expect(verifiedEntryFor(verified, sha("a"), "Other")).toBe(undefined);
	expect(verifiedEntryFor(verified, sha("f"), "Avatar")).toBe(undefined);
	expect(verifiedEntryFor(verified, undefined, "Avatar")).toBe(undefined);
	expect(verifiedEntryFor(undefined, sha("a"), "Avatar")).toBe(undefined);
	// Entries without a name and keys that are not a sha256 are dropped, prototype keys are never entries
	expect(verifiedEntryFor(verified, sha("c"), "")).toBe(undefined);
	expect(Object.keys(verified.entries).sort()).toStrictEqual([sha("a"), sha("b")]);
	expect(verifiedEntryFor(verified, "__proto__", "Avatar")).toBe(undefined);
	expect(verifiedEntryFor(verified, "constructor", "Object")).toBe(undefined);
	// Only http(s) report links
	expect(verified.entries[sha("b")].report).toBe(undefined);
});

test("revoked lookup by sha256; any listed sha256 is revoked, even with a malformed entry", () => {
	expect(revokedEntryFor(revoked, sha("d"))?.reason).toBe("Steals tokens");
	expect(revokedEntryFor(revoked, sha("e"))?.reason).toBe("No reason given");
	expect(revokedEntryFor(revoked, sha("a"))).toBe(undefined);
	expect(revokedEntryFor(revoked, undefined)).toBe(undefined);
	expect(revokedEntryFor(undefined, sha("d"))).toBe(undefined);
	expect(revokedEntryFor(revoked, "toString")).toBe(undefined);
});

test("the raw sha256 is the sha256 of the served .mjs, whatever url serves it", async () => {
	// What the registry computed for the fixture code (sha256 of the file's bytes)
	const url = "https://example.com/Fixture";
	const stored = `${codes.verified}\n//# sourceURL=${url}.mjs`;
	expect(rawCodeOf(stored)).toBe(codes.verified);
	expect(await rawSha256(stored)).toBe(codes.sha256.verified);
	// Same file from another url: same raw sha256, different codeSha256
	const elsewhere = `${codes.verified}\n//# sourceURL=https://other.example/Fixture.mjs`;
	expect(await rawSha256(elsewhere)).toBe(codes.sha256.verified);
	const native = `__ipcRenderer.invoke("__Luna.registerNative", "a.native.ts", "");`;
	const a = `${native}\n//# sourceURL=https://a/P.mjs`;
	const b = `${native}\n//# sourceURL=https://b/P.mjs`;
	expect(await rawSha256(a)).toBe(await rawSha256(b));
	expect(await sha256Hex(codeToImport(a, "https://a/P"))).not.toBe(await sha256Hex(codeToImport(b, "https://b/P")));
	// Only Luna's own suffix is removed: one line, at the very end
	expect(rawCodeOf("a\n//# sourceURL=x.mjs\nb\n//# sourceURL=y.mjs")).toBe("a\n//# sourceURL=x.mjs\nb");
	expect(rawCodeOf("no suffix")).toBe("no suffix");
});

test("revoked code does not load; core plugins are never revoked; dev plugins are checked", () => {
	expect(registryLoadDecision({ url: "https://example.com/Avatar", rawSha256: sha("a") }, revoked)).toStrictEqual({ load: true });
	const decision = registryLoadDecision({ url: "https://example.com/Avatar", rawSha256: sha("d") }, revoked);
	expect(decision.load).toBe(false);
	expect(!decision.load && decision.revoked.reason).toBe("Steals tokens");
	expect(registryLoadDecision({ url: "http://127.0.0.1:3002/Avatar", rawSha256: sha("d") }, revoked).load).toBe(false);
	expect(registryLoadDecision({ url: "https://luna/luna.lib", rawSha256: sha("d") }, revoked).load).toBe(true);
	// No list (fetch failed, nothing cached) or no hash yet: plugins load
	expect(registryLoadDecision({ url: "https://example.com/Avatar", rawSha256: sha("d") }, undefined).load).toBe(true);
	expect(registryLoadDecision({ url: "https://example.com/Avatar", rawSha256: undefined }, revoked).load).toBe(true);
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
	expect(unverifiedPlugins(plugins, verified, revoked).map((p) => p.name)).toStrictEqual(["Unlisted", "Renamed", "Dev", "NotLoadedYet"]);
	// Without a verified list every enabled non-core plugin is unverified
	expect(unverifiedPlugins(plugins, undefined, undefined).length).toBe(6);
});

test("registry base url: https or a local http server, always ending with /", () => {
	expect(registryBaseUrl()).toBe("https://raw.githubusercontent.com/Inrixia/luna-registry/signed/");
	expect(registryBaseUrl("http://127.0.0.1:3002/registry")).toBe("http://127.0.0.1:3002/registry/");
	expect(registryBaseUrl("http://localhost:3002/registry/")).toBe("http://localhost:3002/registry/");
	expect(() => registryBaseUrl("http://example.com/registry/")).toThrow(/https/);
	expect(() => registryBaseUrl("http://127.0.0.1.example.com/")).toThrow(/https/);
	expect(() => registryBaseUrl("file:///C:/registry/")).toThrow(/https/);
	expect(() => registryBaseUrl("http://127.0.0.1:3002/registry/?v=1")).toThrow(/query/);
	expect(() => registryBaseUrl("http://127.0.0.1:3002/registry/#x")).toThrow(/query/);
});

test("a list in use is replaced by the same or a higher serial, not a lower one", () => {
	expect(replacesInUse(undefined, { serial: 1 })).toBe(true);
	expect(replacesInUse({ serial: 2 }, { serial: 2 })).toBe(true);
	expect(replacesInUse({ serial: 2 }, { serial: 3 })).toBe(true);
	expect(replacesInUse({ serial: 2 }, { serial: 1 })).toBe(false);
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
	expect(file.entries[sha]).toStrictEqual(entry);
});

test("revocation reasons end in one full stop", () => {
	expect(asSentence("Steals tokens")).toBe("Steals tokens.");
	expect(asSentence("Steals tokens.")).toBe("Steals tokens.");
	expect(asSentence("Mines crypto!")).toBe("Mines crypto!");
	expect(asSentence("Steals tokens ")).toBe("Steals tokens.");
	expect(asSentence('Says "hi."')).toBe('Says "hi."');
	expect(asSentence("(see report.)")).toBe("(see report.)");
});

test("a new revoked.json stops running revoked plugins and loads again the ones whose revocation was lifted", async () => {
	const revoked = <RevokedFile>parseRegistryFile("revoked.json", new TextDecoder().decode(fixture("revoked.json")));
	const plugin = { url: "https://example.com/P", loaded: true, stoppedByRevocation: false, enabled: true };
	// Running revoked code stops; revoked code that isn't running (still loading, or already stopped) is left to loadExports
	expect(revocationAction({ ...plugin, rawSha256: codes.sha256.revoked }, revoked).action).toBe("stop");
	expect(revocationAction({ ...plugin, rawSha256: codes.sha256.revoked, loaded: false }, revoked).action).toBe("none");
	// Stopped by a revocation that is gone: loads again, unless disabled
	const stopped = { ...plugin, rawSha256: codes.sha256.revoked, loaded: false, stoppedByRevocation: true };
	expect(revocationAction(stopped, undefined).action).toBe("load");
	expect(revocationAction({ ...stopped, enabled: false }, undefined).action).toBe("none");
	expect(revocationAction({ ...plugin, rawSha256: codes.sha256.verified }, revoked).action).toBe("none");
	// Luna's own plugins are never revoked
	expect(revocationAction({ ...plugin, url: "https://luna/luna.lib", rawSha256: codes.sha256.revoked }, revoked).action).toBe("none");
});

test("served code keeps a BOM and refuses invalid UTF-8, so its raw sha256 is the sha256 of the file's bytes", async () => {
	const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(codes.revoked)]);
	expect(await rawSha256(decodeServedCode(withBom))).toBe(createHash("sha256").update(withBom).digest("hex"));
	expect(await rawSha256(decodeServedCode(withBom))).not.toBe(codes.sha256.revoked);
	expect(await rawSha256(decodeServedCode(new TextEncoder().encode(codes.revoked)))).toBe(codes.sha256.revoked);
	expect(() => decodeServedCode(new Uint8Array([0x2f, 0x2f, 0xff, 0x0a]))).toThrow(/not valid UTF-8/);
});

test("a signed file served as the other file, or without kind, is rejected", async () => {
	// revoked.json is validly signed, but its kind says what it is
	const asVerified = await acceptRegistryFile("verified.json", signed("revoked.json"));
	expect(asVerified.ok).toBe(false);
	expect(!asVerified.ok ? asVerified.reason : "").toMatch(/kind "revoked", expected "verified"/);
	const asRevoked = await acceptRegistryFile("revoked.json", signed("verified.json"));
	expect(asRevoked.ok).toBe(false);
	expect(!asRevoked.ok ? asRevoked.reason : "").toMatch(/kind "verified", expected "revoked"/);
	const noKind = await acceptRegistryFile("revoked.json", signed("nokind.json"));
	expect(noKind.ok).toBe(false);
	expect(!noKind.ok ? noKind.reason : "").toMatch(/kind undefined/);
	// The right file is accepted and keeps its kind
	const ok = await acceptRegistryFile("revoked.json", signed("revoked.json"));
	expect(ok.ok && ok.file.kind).toBe("revoked");
});

test("code stored before exact fetching matches its refetch only when it differs by a BOM", () => {
	const url = "https://example.com/Plugin";
	const stored = `export const a = 1;\n//# sourceURL=${url}.mjs`;
	expect(sameServedCode(stored, `﻿export const a = 1;\n//# sourceURL=${url}.mjs`)).toBe(true);
	expect(sameServedCode(stored, `export const a = 1;\n//# sourceURL=${url}2.mjs`)).toBe(true);
	expect(sameServedCode(stored, `export const a = 2;\n//# sourceURL=${url}.mjs`)).toBe(false);
});

test("code stored before exact fetching is looked up by both keys it may have (a BOM dropped or not)", async () => {
	const text = "export const x = 1;";
	const stored = `${text}\n//# sourceURL=https://example.com/X.mjs`;
	const withBom = createHash("sha256")
		.update(Buffer.from(`\uFEFF${text}`, "utf8"))
		.digest("hex");
	expect(await legacyBomSha256(stored)).toBe(withBom);
	// A text that starts with a BOM (the file had two) or has U+FFFD (a literal one) may still have lost a BOM
	const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
	expect(await legacyBomSha256(`\uFEFF${text}`)).toBe(sha(`\uFEFF\uFEFF${text}`));
	expect(await legacyBomSha256(`${text}"\uFFFD"`)).toBe(sha(`\uFEFF${text}"\uFFFD"`));

	const plain = await rawSha256(stored);
	const keys = packageSha256s({ rawSha256: plain, bomRawSha256: withBom });
	expect(keys).toStrictEqual([plain, withBom]);
	expect(packageSha256s({ rawSha256: plain })).toBe(plain);
	expect(packageSha256s(undefined)).toBe(undefined);

	const file = <T>(kind: "verified" | "revoked", entries: Record<string, T>) => ({ schema: 1 as const, kind, serial: 1, entries });
	const revoked = <RevokedFile>file("revoked", { [withBom]: { reason: "Bad" } });
	expect(revokedEntryFor(revoked, keys)?.reason).toBe("Bad");
	expect(revokedEntryFor(revoked, plain)).toBe(undefined);
	expect(registryLoadDecision({ url: "https://example.com/X", rawSha256: keys }, revoked).load).toBe(false);
	const verified = <VerifiedFile>file("verified", { [withBom]: { id: "x", name: "X" } });
	expect(verifiedEntryFor(verified, keys, "X")?.id).toBe("x");
	expect(verifiedEntryFor(verified, keys, "Y")).toBe(undefined);
	expect(verifiedEntryFor(verified, [undefined, undefined], "X")).toBe(undefined);
	expect(
		unverifiedPlugins([{ url: "https://example.com/X", name: "X", installed: true, enabled: true, rawSha256: keys }], verified, undefined),
	).toStrictEqual([]);
});

test("a revoked accepted update gives back the version it replaced, only while it is the code the plugin has", () => {
	const previous = { rawSha256: sha("a"), version: "1" };
	const replaced = { rawSha256: sha("b"), previous };
	expect(versionToRestore(replaced, { rawSha256: sha("b") })).toBe(previous);
	// Other code now (dev reload, a newer update): nothing to restore
	expect(versionToRestore(replaced, { rawSha256: sha("c") })).toBe(undefined);
	expect(versionToRestore(replaced, { rawSha256: undefined })).toBe(undefined);
	expect(versionToRestore(replaced, undefined)).toBe(undefined);
	expect(versionToRestore(undefined, { rawSha256: sha("b") })).toBe(undefined);
});

test("live reload stops while the plugin's code is revoked", () => {
	expect(keepsLiveReloading({ enabled: true, liveReload: true, revoked: false })).toBe(true);
	expect(keepsLiveReloading({ enabled: true, liveReload: true, revoked: true })).toBe(false);
	expect(keepsLiveReloading({ enabled: false, liveReload: true, revoked: false })).toBe(false);
	expect(keepsLiveReloading({ enabled: true, liveReload: false, revoked: false })).toBe(false);
});

test("dependants of another revoked plugin stopping are found, through other plugins and cycles", () => {
	type Node = { name: string; dependants: Set<Node> };
	const node = (name: string): Node => ({ name, dependants: new Set() });
	const [a, b, c, d] = ["a", "b", "c", "d"].map(node);
	// b depends on a, c on b; d on nothing
	a.dependants.add(b);
	b.dependants.add(c);
	expect(dependsOnAny(b, [a, b])).toBe(true);
	expect(dependsOnAny(c, [a, c])).toBe(true);
	expect(dependsOnAny(a, [a, b, c])).toBe(false);
	expect(dependsOnAny(d, [a, b, c, d])).toBe(false);
	expect(dependsOnAny(b, [b])).toBe(false);
	// A cycle doesn't loop
	c.dependants.add(a);
	expect(dependsOnAny(d, [a])).toBe(false);
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
	expect(changedDependency(imported, stateOf)).toBe(undefined);
	// Revoked or disabled: unloaded since
	set("b", { unloadCount: 1, unloading: false, loaded: false });
	expect(changedDependency(imported, stateOf)).toBe("b");
	// Reloaded since: loaded again, but not the exports the import took
	set("b", { unloadCount: 1, unloading: false, loaded: true });
	expect(changedDependency(imported, stateOf)).toBe("b");
	// Still unloading: exports still there, count not moved yet
	set("b", { unloadCount: 0, unloading: true, loaded: true });
	expect(changedDependency(imported, stateOf)).toBe("b");
	// Not loaded without an unload counted (never loaded)
	set("b", { unloadCount: 0, unloading: false, loaded: false });
	expect(changedDependency(imported, stateOf)).toBe("b");
	// A plugin it doesn't import changing is not its concern
	set("b", { unloadCount: 0, unloading: false, loaded: true });
	states.set("c", { unloadCount: 5, unloading: true, loaded: false });
	expect(changedDependency(imported, stateOf)).toBe(undefined);
	expect(changedDependency(new Map(), stateOf)).toBe(undefined);
});

test("the card says why a plugin waits for a dependency", () => {
	expect(dependencyWaitMessage({ name: "X", revoked: true, pending: true })!).toMatch(/depends on X, which the Luna plugin registry revoked/);
	expect(dependencyWaitMessage({ name: "X", revoked: false, pending: true })).toBe(undefined);
	expect(dependencyWaitMessage({ name: "X", revoked: false, pending: false })!).toMatch(/depends on X, which is not loaded/);
});
