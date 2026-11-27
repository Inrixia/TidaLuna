// LunaRegistry against a fake registry server (fetch) and an in-memory store, with the signed fixtures of helpers/registry.fixtures
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

// The trace module patches window on import
globalThis.window ??= <any>globalThis;
const { LunaRegistry } = await import("./LunaRegistry");

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(process.cwd(), "render/src/helpers/registry.fixtures", name)));
const codes: { sha256: { verified: string; revoked: string } } = JSON.parse(new TextDecoder().decode(fixture("codes.json")));

// The server: url > bytes. Missing urls are 404
const base = "http://127.0.0.1:3002/registry/";
let served = new Map<string, Uint8Array>();
const serve = (files: Record<string, string>, at: string = base) => {
	served = new Map(Object.entries(files).map(([name, from]) => [`${at}${name}`, fixture(from)]));
};
globalThis.fetch = async (input) => {
	const bytes = served.get(String(input));
	return bytes === undefined ? new Response("", { status: 404, statusText: "Not Found" }) : new Response(<Uint8Array<ArrayBuffer>>bytes);
};

// The store, in memory
let stored = new Map<string, unknown>();
const storage = <any>LunaRegistry.storage;
storage.get = async (key: string) => stored.get(key);
storage.set = async (key: string, value: unknown) => void stored.set(key, value);
storage.del = async (key: string) => void stored.delete(key);

/** A client start: nothing in use, the store as it was (or empty) */
const restart = (store: Map<string, unknown> = new Map()) => {
	stored = store;
	stored.set("baseUrl", base);
	LunaRegistry.verified._ = undefined;
	LunaRegistry.revoked._ = undefined;
	LunaRegistry.status._ = { "verified.json": { source: "none" }, "revoked.json": { source: "none" } };
};
const good = {
	"verified.json": "verified.json",
	"verified.json.sig": "verified.json.sig",
	"revoked.json": "revoked.json",
	"revoked.json.sig": "revoked.json.sig",
};

test("refresh: fetched, checked and signed lists are used and stored with their serials", async () => {
	restart();
	serve(good);
	await LunaRegistry.refresh();
	expect(LunaRegistry.verified._?.serial).toBe(3);
	expect(LunaRegistry.revoked._?.serial).toBe(2);
	expect(LunaRegistry.verifiedEntry(codes.sha256.verified, "Fixture")?.name).toBe("Fixture");
	expect(LunaRegistry.loadDecision({ url: "https://example.com/Fixture", rawSha256: codes.sha256.revoked }).load).toBe(false);
	expect(LunaRegistry.status._["revoked.json"]).toStrictEqual({ source: "fetched", serial: 2, generated: LunaRegistry.revoked._?.generated });
	expect(stored.get(`${base}verified.json.serial`)).toBe(3);
	expect(stored.get(`${base}revoked.json.serial`)).toBe(2);
});

test("loadCached: the stored copies are checked again and used at the next start", async () => {
	restart();
	serve(good);
	await LunaRegistry.refresh();
	restart(stored);
	await LunaRegistry.loadCached();
	expect(LunaRegistry.revoked._?.serial).toBe(2);
	expect(LunaRegistry.status._["revoked.json"].source).toBe("cached");
	// A stored copy that no longer checks out is not used
	const copy = <{ bytes: string }>stored.get(`${base}verified.json`);
	stored.set(`${base}verified.json`, { ...copy, bytes: Buffer.from("{}").toString("base64") });
	restart(stored);
	await LunaRegistry.loadCached();
	expect(LunaRegistry.verified._).toBe(undefined);
	expect(LunaRegistry.status._["verified.json"].source).toBe("none");
});

test("a failed or badly signed fetch keeps the copy in use and says why, without relabelling it", async () => {
	restart();
	serve(good);
	await LunaRegistry.refresh();
	// verified.json with revoked.json's signature, and no revoked.json at all
	serve({ "verified.json": "verified.json", "verified.json.sig": "revoked.json.sig" });
	await LunaRegistry.refresh();
	expect(LunaRegistry.verified._?.serial).toBe(3);
	expect(LunaRegistry.revoked._?.serial).toBe(2);
	expect(LunaRegistry.status._["verified.json"].error ?? "").toMatch(/signature/);
	expect(LunaRegistry.status._["revoked.json"].error ?? "").toMatch(/404/);
	expect(LunaRegistry.status._["revoked.json"].source).toBe("fetched");
	// The next good fetch clears the error
	serve(good);
	await LunaRegistry.refresh();
	expect(LunaRegistry.status._["revoked.json"].error).toBe(undefined);
});

test("a signed file with a lower serial than one accepted before is rejected (rollback), even after a restart", async () => {
	restart();
	serve(good);
	await LunaRegistry.refresh();
	restart(stored);
	serve({ ...good, "revoked.json": "revoked-serial1.json", "revoked.json.sig": "revoked-serial1.json.sig" });
	await LunaRegistry.refresh();
	expect(LunaRegistry.revoked._).toBe(undefined);
	expect(LunaRegistry.status._["revoked.json"].error ?? "").toMatch(/serial 1 is lower than 2/);
	expect(stored.get(`${base}revoked.json.serial`)).toBe(2);
});

test("a stored copy read after a newer fetch does not replace it (slow IndexedDB at startup)", async () => {
	// The store holds serial 1 and no serial yet, as if the newer fetch had not stored its own
	restart();
	serve({ "revoked.json": "revoked-serial1.json", "revoked.json.sig": "revoked-serial1.json.sig" });
	await LunaRegistry.refresh();
	const olderCopy = stored.get(`${base}revoked.json`);
	stored.delete(`${base}revoked.json.serial`);
	serve(good);
	await LunaRegistry.refresh();
	stored.set(`${base}revoked.json`, olderCopy);
	stored.delete(`${base}revoked.json.serial`);
	await LunaRegistry.loadCached();
	expect(LunaRegistry.revoked._?.serial).toBe(2);
	expect(LunaRegistry.status._["revoked.json"].source).toBe("fetched");
});

test("an invalid baseUrl override is ignored", async () => {
	restart();
	stored.set("baseUrl", "http://example.com/registry/");
	expect(await LunaRegistry.baseUrl()).toBe("https://raw.githubusercontent.com/Inrixia/luna-registry/signed/");
	stored.set("baseUrl", "https://evil.example/registry/");
	expect(await LunaRegistry.baseUrl()).toBe("https://raw.githubusercontent.com/Inrixia/luna-registry/signed/");
});

test("serials are kept per registry url: a local test registry doesn't block the real one", async () => {
	restart();
	serve(good);
	await LunaRegistry.refresh();
	const other = "http://localhost:3005/registry/";
	stored.set("baseUrl", other);
	serve({ "revoked.json": "revoked-serial1.json", "revoked.json.sig": "revoked-serial1.json.sig" }, other);
	await LunaRegistry.refresh();
	expect(LunaRegistry.status._["revoked.json"].error).toBe(undefined);
	expect(LunaRegistry.revoked._?.serial).toBe(1);
	expect(stored.get(`${other}revoked.json.serial`)).toBe(1);
	expect(stored.get(`${base}revoked.json.serial`)).toBe(2);
});

test("a stored copy older than the serial accepted before (saving it failed): revoked.json is still used, verified.json is not", async () => {
	restart();
	serve({ "revoked.json": "revoked-serial1.json", "revoked.json.sig": "revoked-serial1.json.sig" });
	await LunaRegistry.refresh();
	const olderCopy = stored.get(`${base}revoked.json`);
	serve(good);
	await LunaRegistry.refresh();
	// The serials were stored, the newer copies were not
	stored.set(`${base}revoked.json`, olderCopy);
	stored.set(`${base}verified.json.serial`, 4);
	restart(stored);
	await LunaRegistry.loadCached();
	// An older list of revocations still revokes what it lists, until the fetch replaces it
	expect(LunaRegistry.revoked._?.serial).toBe(1);
	expect(LunaRegistry.status._["revoked.json"].source).toBe("cached");
	expect(LunaRegistry.status._["revoked.json"].error ?? "").toMatch(/#1 is older than #2/);
	// A verified build may have been dropped since: nothing is badged
	expect(LunaRegistry.verified._).toBe(undefined);
	expect(LunaRegistry.status._["verified.json"].source).toBe("none");
	expect(LunaRegistry.status._["verified.json"].error ?? "").toMatch(/#3 is older than #4/);
	// The serial is not lowered, and the next fetch is used
	expect(stored.get(`${base}revoked.json.serial`)).toBe(2);
	await LunaRegistry.refresh();
	expect(LunaRegistry.revoked._?.serial).toBe(2);
	expect(LunaRegistry.status._["revoked.json"].error).toBe(undefined);
});

test("only verified updates: on by default and after a restart unless turned off; offers only verified code then", async () => {
	restart();
	serve(good);
	await LunaRegistry.loadCached();
	await LunaRegistry.refresh();
	expect(LunaRegistry.verifiedUpdatesOnly._).toBe(true);
	expect(LunaRegistry.updateOffered(codes.sha256.verified, "Fixture")).toBe(true);
	// Unlisted code, code verified under another name, code not hashed yet
	expect(LunaRegistry.updateOffered(codes.sha256.revoked, "Fixture")).toBe(false);
	expect(LunaRegistry.updateOffered(codes.sha256.verified, "Other")).toBe(false);
	expect(LunaRegistry.updateOffered(undefined, "Fixture")).toBe(false);

	await LunaRegistry.setVerifiedUpdatesOnly(false);
	expect(LunaRegistry.updateOffered(codes.sha256.revoked, "Fixture")).toBe(true);
	restart(stored);
	LunaRegistry.verifiedUpdatesOnly._ = true;
	await LunaRegistry.loadCached();
	expect(LunaRegistry.verifiedUpdatesOnly._).toBe(false);

	await LunaRegistry.setVerifiedUpdatesOnly(true);
	restart(stored);
	await LunaRegistry.loadCached();
	expect(LunaRegistry.verifiedUpdatesOnly._).toBe(true);
	// No verified list (registry unreachable, nothing cached): nothing is offered
	restart();
	await LunaRegistry.loadCached();
	expect(LunaRegistry.updateOffered(codes.sha256.verified, "Fixture")).toBe(false);
});
