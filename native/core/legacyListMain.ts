// The main-process side of the old native format list (legacyList.ts): the last good copy in
// userData/luna-core/legacy.json (+ .sig), refreshed from luna-registry. A fetched list replaces it only if it is signed
// and a subset of it (replacesList): nobody can add to it here, not the network, not the page, not a file put in place
// of the copy (its signature is checked whenever it is read).
import { app, net } from "electron";

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";

import { legacyListUrl, parseLegacyList, replacesList, type LegacyList } from "./legacyList";

const cacheFile = () => path.join(app.getPath("userData"), "luna-core", "legacy.json");
// Refreshed while TIDAL runs: a plugin taken off the list stops on the next load
const REFRESH_MS = 6 * 60 * 60 * 1000;
// The first start with no copy waits this long for the list before refusing old-format natives
const FIRST_WAIT_MS = 10000;

let current: LegacyList | undefined;
/** `${id}\n${sha256}` of the current list */
let allowed = new Set<string>();
const use = (list: LegacyList) => {
	current = list;
	allowed = new Set(list.entries.map((e) => `${e.id}\n${e.sha256}`));
};

let readCache = false;
const loadCache = () => {
	if (readCache) return;
	readCache = true;
	try {
		use(parseLegacyList(readFileSync(cacheFile()), readFileSync(`${cacheFile()}.sig`, "utf8")));
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") console.error("[Luna.core] The stored old native format list is not usable:", err);
	}
};

const fetchBytes = async (url: string) => {
	const res = await net.fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
	if (!res.ok) throw new Error(`${url}: ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
};

const refresh = async () => {
	loadCache();
	const [bytes, sig] = await Promise.all([fetchBytes(legacyListUrl), fetchBytes(`${legacyListUrl}.sig`)]);
	const next = parseLegacyList(bytes, sig.toString("utf8"));
	const replaces = replacesList(current, next);
	if (!replaces.ok) throw new Error(`refused: ${replaces.reason}`);
	if (current !== undefined && next.serial === current.serial) return;
	const file = cacheFile();
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(`${file}.tmp`, bytes);
	writeFileSync(`${file}.sig.tmp`, sig);
	renameSync(`${file}.tmp`, file);
	renameSync(`${file}.sig.tmp`, `${file}.sig`);
	use(next);
	console.log(`[Luna.core] Old native format list: serial ${next.serial}, ${next.entries.length} plugins`);
};

let first: Promise<void> | undefined;
/** Starts the refreshes (once); resolves when the first one settled */
const start = () =>
	(first ??= (() => {
		const run = () => refresh().catch((err) => console.warn("[Luna.core] Old native format list not refreshed:", err?.message ?? err));
		setInterval(run, REFRESH_MS).unref();
		return run();
	})());

/** Whether the current list has this plugin's code (see RegistryDeps.legacyAllows) */
export const legacyAllows = (id: string, servedSha256: string): boolean => {
	loadCache();
	void start();
	return allowed.has(`${id}\n${servedSha256}`);
};

/** Before the first check of a start with no stored copy: waits a little for the first fetch */
export const legacyListReady = async (): Promise<void> => {
	loadCache();
	const started = start();
	if (current !== undefined) return;
	await Promise.race([started, new Promise((resolve) => setTimeout(resolve, FIRST_WAIT_MS))]);
};
