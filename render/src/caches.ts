// The page's caches. No TIDAL boot imports, so tests can import it
import { Cache, CacheStore, MapBackend } from "../../cache";
import { hookFetch, SharedRequests, type Entry } from "./SharedRequests";

const MB = 1024 ** 2;

/** The page's shared requests, see `SharedRequests` */
export const sharedRequests = new SharedRequests(
	Cache.from("requests", () => ({
		desc: "Responses to TIDAL's and Luna's requests (items, album pages, playback info), shared and kept for the session",
		memory: new CacheStore({ meta: new MapBackend(), data: new MapBackend<Entry>(), bytesLimit: 64 * MB }),
	})),
);
hookFetch(sharedRequests);

// The page can go away at any time: save every cache's changed metas now
addEventListener("pagehide", () => Cache.flushAll());
