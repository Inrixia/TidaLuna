// The main-process side of the old native format list (legacyList.ts): the last good copy in
// userData/luna-core/legacy-list.json, refreshed from luna-registry. A fetched list replaces it only if it is signed
// and a subset of it (replacesList): nobody can add to it here, not the network, not the page, not a file put in place
// of the copy (its signature is checked whenever it is read).
import { app, net } from "electron";

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";

import { createLegacyStore, legacyListUrl } from "./legacyList";

const cacheFile = () => path.join(app.getPath("userData"), "luna-core", "legacy-list.json");
// Refreshed while TIDAL runs: a plugin taken off the list stops on the next load
const REFRESH_MS = 6 * 60 * 60 * 1000;

const fetchBytes = async (url: string) => {
	const res = await net.fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
	if (!res.ok) throw new Error(`${url}: ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
};

const store = createLegacyStore({
	readCache: () => {
		try {
			return readFileSync(cacheFile(), "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
			throw err;
		}
	},
	writeCache: (text) => {
		const file = cacheFile();
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(`${file}.tmp`, text);
		renameSync(`${file}.tmp`, file);
	},
	fetchList: async () => {
		const [bytes, sig] = await Promise.all([fetchBytes(legacyListUrl), fetchBytes(`${legacyListUrl}.sig`)]);
		return { bytes, sig: sig.toString("utf8") };
	},
	log: (message) => console.warn(message),
});

let timer: NodeJS.Timeout | undefined;
const startTimer = () => {
	timer ??= setInterval(() => void store.refreshNow(), REFRESH_MS);
	timer.unref();
};

/** Whether the current list has this plugin's code (see RegistryDeps.legacyAllows) */
export const legacyAllows = (id: string, servedSha256: string): boolean => {
	startTimer();
	return store.allows(id, servedSha256);
};

/** Whether a list that grants is loaded (cached or fetched; not expired, not older than this build) */
export const legacyListLoaded = (): boolean => store.usable();

/** Before the first check of a start with no stored copy: waits a little for the first fetch */
export const legacyListReady = (): Promise<void> => {
	startTimer();
	return store.ready();
};

/** The derived hosts the current list carries for this plugin's code (LegacyListEntry hosts) */
export const legacyHosts = (id: string, servedSha256: string): string[] | undefined =>
	store.current()?.entries.find((e) => e.id === id && e.sha256 === servedSha256)?.hosts;
