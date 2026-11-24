// lib's caches: built here and used by the classes that need them
import { store as obyStore } from "oby";

import { Cache, CacheStore, MapBackend, ObyBackend, ReactiveStore, ReactiveStoreBackend, WeakRefs } from "@luna/core";

import { MusicBrainz } from "./classes/MusicBrainz";
import type { MediaFormat, TrackPlaybackInfo } from "./classes/PlaybackInfo";
import type * as redux from "./redux";

const MiB = 1024 ** 2;
const DAY_MS = 24 * 60 * 60_000;

/** Decoded playback infos by `trackId:audioQuality`, unavailable ones too, kept while their manifest urls are valid. The values are promises in flight */
export const playbackInfos = Cache.from("playbackInfo", () => ({
	desc: "Decoded stream manifests by item and quality, kept while their urls are valid",
	memory: new CacheStore({ meta: new MapBackend(), data: new MapBackend<Promise<TrackPlaybackInfo | undefined>>(), bytesLimit: 4 * MiB }),
	maxAgeMs: 45 * 60_000, // 45 minutes, manifest urls hold a token valid for an hour
}));

// Formats were kept in other stores before
indexedDB.deleteDatabase("@luna/MediaItemCache");
indexedDB.deleteDatabase("@luna/formats.records");

/** Formats by `trackId:audioQuality`. Held in memory as oby stores so changes are saved (below) and heard by `PlaybackInfo.withFormat` */
export const playbackFormats: Cache<
	CacheStore<MapBackend, ObyBackend<MediaFormat>>,
	CacheStore<ReactiveStoreBackend, ReactiveStoreBackend<MediaFormat>>
> = Cache.from("formats", () => ({
	desc: "Formats (bit depth, sample rate, codec, size) of the streams read, kept across restarts",
	memory: new CacheStore({
		meta: new MapBackend(),
		// A reader changed a format: save it. Unwrapped as IndexedDB can't store an oby proxy
		data: new ObyBackend<MediaFormat>((key, store) => void playbackFormats.set(key, obyStore.unwrap(store), { write: "async" }).catch(() => {})),
	}),
	persist: new CacheStore({
		meta: new ReactiveStoreBackend(ReactiveStore.getStore("@luna/formats.metas")),
		data: new ReactiveStoreBackend<MediaFormat>(ReactiveStore.getStore("@luna/formats")),
		bytesLimit: 16 * MiB,
	}),
	write: "async",
}));

const musicBrainzCache = Cache.from("musicBrainz", () => ({
	desc: "Responses of the MusicBrainz API (releases, recordings, ISRC lookups), kept across restarts",
	memory: new CacheStore({ meta: new MapBackend(), data: new MapBackend<unknown>(), bytesLimit: 4 * MiB }),
	persist: new CacheStore({
		meta: new ReactiveStoreBackend(ReactiveStore.getStore("@luna/musicBrainz.metas")),
		data: new ReactiveStoreBackend<unknown>(ReactiveStore.getStore("@luna/musicBrainz")),
		bytesLimit: 32 * MiB,
	}),
	write: "async",
	maxAgeMs: 7 * DAY_MS,
}));
export const musicBrainz = new MusicBrainz(musicBrainzCache);

/** The best `MediaItem` id of an ISRC, in flight or resolved (the items themselves are `contentInstances`) */
export const isrcItems = Cache.from("isrcItems", () => ({
	desc: "The best item of an ISRC, kept for the session",
	memory: new CacheStore({ meta: new MapBackend(), data: new MapBackend<Promise<redux.ItemId | undefined>>(), bytesLimit: MiB }),
}));

const contentCaches = new Map<string, { cache: Cache<CacheStore<MapBackend, MapBackend<object>>, undefined>; weakRefs: WeakRefs<object> }>();
/**
 * The instances of a content type (`mediaItems`, `albums`...): a bounded cache of the recent ones and, weakly, every one still referenced.
 * `ContentBase.fromStore` asks the cache, then the weak refs, so an id gives the same instance while anything holds it
 */
export const contentInstances = (contentType: string) => {
	let instances = contentCaches.get(contentType);
	if (instances === undefined) {
		const cache = Cache.from(`content.${contentType}`, () => ({
			desc: `Recently used ${contentType} instances (the same instance is given while anything references it)`,
			memory: new CacheStore({ meta: new MapBackend(), data: new MapBackend<object>(), bytesLimit: 8 * MiB }),
		}));
		contentCaches.set(contentType, (instances = { cache, weakRefs: new WeakRefs<object>() }));
	}
	return instances;
};
