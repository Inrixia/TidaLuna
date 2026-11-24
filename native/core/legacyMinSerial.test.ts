import { describe, expect, it } from "vitest";

import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { legacyPublicKey } from "./legacyList";

const repo = path.resolve(import.meta.dirname, "../..");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

/** scripts/legacyMinSerial.mjs in a copy of the files it reads, with this test's key in legacyList.ts */
const sandbox = (serial: number) => {
	const dir = mkdtempSync(path.join(tmpdir(), "legacy-min-serial-"));
	mkdirSync(path.join(dir, "scripts"));
	mkdirSync(path.join(dir, "native/core"), { recursive: true });
	copyFileSync(path.join(repo, "scripts/legacyMinSerial.mjs"), path.join(dir, "scripts/legacyMinSerial.mjs"));
	const list = readFileSync(path.join(repo, "native/core/legacyList.ts"), "utf8");
	expect(list.includes(legacyPublicKey)).toBeTruthy();
	writeFileSync(path.join(dir, "native/core/legacyList.ts"), list.replace(legacyPublicKey, pub));
	const source = readFileSync(path.join(repo, "native/core/legacyMinSerial.ts"), "utf8").replace(
		/legacyMinSerial = \d+;/,
		`legacyMinSerial = ${serial};`,
	);
	writeFileSync(path.join(dir, "native/core/legacyMinSerial.ts"), source);
	const run = (doc: object, key = privateKey) => {
		const bytes = Buffer.from(JSON.stringify(doc));
		writeFileSync(path.join(dir, "legacy.json"), bytes);
		writeFileSync(path.join(dir, "legacy.json.sig"), sign(null, bytes, key).toString("base64"));
		return spawnSync(process.execPath, ["scripts/legacyMinSerial.mjs", "--file", "legacy.json", "--sig", "legacy.json.sig"], {
			cwd: dir,
			encoding: "utf8",
		});
	};
	const serialNow = () => Number(readFileSync(path.join(dir, "native/core/legacyMinSerial.ts"), "utf8").match(/legacyMinSerial = (\d+);/)?.[1]);
	return { run, serialNow };
};
const list = (serial: number, extra: object = {}) => ({
	kind: "legacy",
	schema: 1,
	serial,
	cutoff: "c",
	validUntil: "2099-01-01T00:00:00.000Z",
	entries: [],
	...extra,
});

describe("legacyMinSerial.mjs (release step)", () => {
	it("raises the build's minimum serial to the signed list's", () => {
		const { run, serialNow } = sandbox(3);
		expect(run(list(7)).status).toBe(0);
		expect(serialNow()).toBe(7);
		// The same again: unchanged
		expect(run(list(7)).status).toBe(0);
		expect(serialNow()).toBe(7);
	});

	it("refuses a list that doesn't verify, isn't a legacy list or is older than the build", () => {
		const { run, serialNow } = sandbox(5);
		expect(run(list(9), generateKeyPairSync("ed25519").privateKey).stderr).toMatch(/signature does not verify/);
		expect(run(list(9, { kind: "trust" })).stderr).toMatch(/not a legacy list/);
		expect(run(list(4)).stderr).toMatch(/lower than legacyMinSerial 5/);
		expect(serialNow()).toBe(5);
	});
});
