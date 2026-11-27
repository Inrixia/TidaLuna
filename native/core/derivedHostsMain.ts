// The main-process side of the registry's derived hosts (derivedHosts.ts): the last good verified.json in
// userData/luna-core/verified-hosts.json, refreshed from luna-registry.
import { app, net } from "electron";

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";

import { createDerivedStore, verifiedListUrl } from "./derivedHosts";

const cacheFile = () => path.join(app.getPath("userData"), "luna-core", "verified-hosts.json");
const REFRESH_MS = 6 * 60 * 60 * 1000;

const fetchBytes = async (url: string) => {
	const res = await net.fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
	if (!res.ok) throw new Error(`${url}: ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
};

const store = createDerivedStore({
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
		const [bytes, sig] = await Promise.all([fetchBytes(verifiedListUrl), fetchBytes(`${verifiedListUrl}.sig`)]);
		return { bytes, sig: sig.toString("utf8") };
	},
	log: (message) => console.warn(message),
});

let timer: NodeJS.Timeout | undefined;
const startTimer = () => {
	timer ??= setInterval(() => void store.refreshNow(), REFRESH_MS);
	timer.unref();
};

/** The hosts the registry derived for this exact code of this plugin, undefined if it has none for it */
export const derivedHosts = (servedSha256: string, name: string): string[] | undefined => {
	startTimer();
	return store.lookup(servedSha256, name);
};
export const derivedHostsLoaded = () => store.loaded();
export const derivedHostsReady = (): Promise<void> => {
	startTimer();
	return store.ready();
};
