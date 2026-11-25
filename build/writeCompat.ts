import { createHash } from "crypto";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";

import { buildCompat, type CompatFile, type TidalCompat } from "../native/compat";

/**
 * Writes the `compat.json` a release publishes beside `luna.zip`.
 *
 * It exists as its own asset because a file cannot carry the digest of the archive it is packed in: the agent that decides
 * whether to install a release reads this before downloading anything, and checks the archive against it afterwards.
 *
 * Run from the release workflow, after the zip is made: `tsx build/writeCompat.ts luna.zip package.json compat.json`
 */

/** What a package.json may declare about the TIDAL builds it was tested on: `"tidal": { "tested": ["2.48.0"] }` */
export type CompatPackage = { version?: unknown; tidal?: TidalCompat };

export const compatForArchive = (zipBytes: Uint8Array, pkg: CompatPackage): CompatFile => {
	if (typeof pkg.version !== "string" || !/^\d+(\.\d+)*(-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
		throw new Error(`[COMPAT] package.json has no usable version, got ${JSON.stringify(pkg.version)}`);
	}
	return buildCompat({
		lunaVersion: pkg.version,
		// A release that declares nothing publishes no claims, which the other side reports as unknown rather than guessing
		tidal: pkg.tidal ?? {},
		zip: { sha256: createHash("sha256").update(zipBytes).digest("hex"), bytes: zipBytes.length },
	});
};

const run = async () => {
	const [zipPath = "luna.zip", pkgPath = "package.json", outPath = "compat.json"] = process.argv.slice(2);
	const zipBytes = await readFile(zipPath);
	const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as CompatPackage;
	const compat = compatForArchive(zipBytes, pkg);
	await writeFile(outPath, `${JSON.stringify(compat, null, "\t")}\n`);
	console.log(`[COMPAT] ${outPath} for ${compat.luna}: zip ${compat.zip.sha256}, tidal ${JSON.stringify(compat.tidal)}`);
};

// Only when run as a script: importing this file (from a test, say) must not read or write anything
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	run().catch((err) => {
		console.error("[COMPAT] Failed:", err);
		process.exit(1);
	});
}
