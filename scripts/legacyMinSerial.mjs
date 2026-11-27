// Before a release build: sets native/core/legacyMinSerial.ts to the serial of luna-registry's signed legacy.json, so
// the build refuses every list signed before it (legacyList.ts). The list is checked like the client does (the key in
// legacyList.ts, kind "legacy"); the serial is only ever raised.
//   node scripts/legacyMinSerial.mjs [--allow-404] [--file <legacy.json> --sig <legacy.json.sig>]
// Any error fails, also a fetch that fails: a release must not fall back to the committed serial unseen.
// --allow-404: the list isn't published (yet): a warning, and the committed serial stays. Drop it once it is.
// Nix builds don't run this: they use the committed serial, so a release also commits it (pnpm run legacy-serial).
// --file/--sig: a local copy instead of the url (tests, or a list signed but not published yet).
import { createPublicKey, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const arg = (name) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? undefined : process.argv[i + 1];
};
const root = new URL("../", import.meta.url);
const listSource = readFileSync(new URL("native/core/legacyList.ts", root), "utf8");
const serialFile = new URL("native/core/legacyMinSerial.ts", root);
const serialSource = readFileSync(serialFile, "utf8");

const constant = (name) => {
	const found = listSource.match(new RegExp(`export const ${name} = "([^"]+)";`));
	if (found === null) throw new Error(`${name} not found in legacyList.ts`);
	return found[1];
};
const SERIAL = /export const legacyMinSerial = (\d+);/;
const current = Number(serialSource.match(SERIAL)?.[1]);
if (!Number.isSafeInteger(current)) throw new Error("legacyMinSerial not found in legacyMinSerial.ts");

/** The signed list's bytes and signature, from the files given or the url; undefined if it can't be fetched */
const load = async () => {
	if (arg("file") !== undefined) return { bytes: readFileSync(arg("file")), sig: readFileSync(arg("sig"), "utf8") };
	const url = constant("legacyListUrl");
	const get = async (u) => {
		const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
		if (res.status === 404 && process.argv.includes("--allow-404")) return undefined;
		if (!res.ok) throw new Error(`${u}: ${res.status}`);
		return Buffer.from(await res.arrayBuffer());
	};
	const [bytes, sig] = await Promise.all([get(url), get(`${url}.sig`)]);
	if (bytes === undefined || sig === undefined) {
		console.log(`::warning::${url} is not published (404): legacyMinSerial stays ${current}`);
		return undefined;
	}
	return { bytes, sig: sig.toString("utf8") };
};

const list = await load();
if (list !== undefined) {
	const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(constant("legacyPublicKey"), "base64")]);
	const key = createPublicKey({ key: spki, format: "der", type: "spki" });
	if (!verify(null, list.bytes, key, Buffer.from(list.sig.trim(), "base64")))
		throw new Error("legacy.json: the signature does not verify with legacyPublicKey");
	const doc = JSON.parse(list.bytes.toString("utf8"));
	if (doc?.kind !== "legacy" || !Number.isSafeInteger(doc.serial) || doc.serial < 1)
		throw new Error("legacy.json: not a legacy list with a serial");
	if (doc.serial < current) throw new Error(`legacy.json serial ${doc.serial} is lower than legacyMinSerial ${current}: an older list is served`);
	if (doc.serial > current) writeFileSync(serialFile, serialSource.replace(SERIAL, `export const legacyMinSerial = ${doc.serial};`));
	console.log(`legacyMinSerial ${current} -> ${doc.serial}`);
}
