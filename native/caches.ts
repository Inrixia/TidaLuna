// The native composition root: every main process cache, made once the app is ready (userData is set then), and the functions the page
// works them through over IPC (see plugins/lib NativeCache). Add a cache by adding it to the object `nativeCaches` resolves to
import electron from "electron";

import { Cache, CacheStore, MapBackend, StreamBufferBackend, type CacheStats } from "../cache";
import { AudioStreams, type AudioMeta, type AudioStreamStatus } from "./AudioStreams";
import { FsBackend, type FsMeta } from "./cache/FsBackend";
import { UserCache } from "./cache/UserCache";
import { OfflineResponses, type OfflineMeta } from "./OfflineResponses";

const MiB = 1024 ** 2; // 1 MiB
const GiB = 1024 ** 3; // 1 GiB

/** Synchronous handle once `nativeCaches` resolves, for synchronous `player.message` rewriting and loopback url lookup */
let audioInstance: AudioStreams | undefined;

export const nativeCaches = UserCache.ready.then((user) => {
	const audio = new AudioStreams(
		Cache.from("audio", () => ({
			desc: "Audio of tracks played, hovered and around the playing one in the queue, played from cache instead of streamed again",
			// Hot cached tracks stay in RAM up to 256 MiB (skipping oversized >64 MiB tracks so one hi-res file doesn't crowd out the tier)
			memory: new CacheStore({
				meta: new MapBackend(),
				data: new StreamBufferBackend(),
				bytesLimit: 256 * MiB,
				maxValueBytes: 64 * MiB,
			}),
			persist: new CacheStore({
				meta: user.metaBackend("audio"),
				data: new FsBackend<AudioMeta>(user.dir("audio")),
				bytesLimit: 128 * GiB,
			}),
		})),
	);
	audioInstance = audio;
	return {
		audio,
		offline: new OfflineResponses(
			Cache.from("offline", () => ({
				desc: "The last response to each of the page's requests, replayed when the network fails so TIDAL works offline",
				// 32 MiB of the small, often replayed ones are held in memory
				memory: new CacheStore({ meta: new MapBackend(), data: new MapBackend<Uint8Array>(), bytesLimit: 32 * MiB }),
				persist: new CacheStore({
					meta: user.metaBackend("offline"),
					data: new FsBackend<OfflineMeta>(user.dir("offline")),
					bytesLimit: GiB,
				}),
			})),
		),
	};
});

// AudioStreams helpers exposed to injector.ts and plugins/lib.native
export type { AudioMeta, AudioStreamStatus };
export const rewritePlayerMessage = (message: string): string => audioInstance?.rewritePlayerMessage(message) ?? message;
export const audioStreamsUrl = (url: string): string | undefined => audioInstance?.url(url);
export const audioStreamsWindow = async (urls: string[]): Promise<void> => (await nativeCaches).audio.window(urls);
export const audioStreamsHover = async (url: string): Promise<void> => (await nativeCaches).audio.hover(url);
export const audioStreamsWaitFilled = async (url: string): Promise<boolean> => (await nativeCaches).audio.waitFilled(url);
export const audioStreamsStore = async (url: string, dataStream?: ReadableStream<Uint8Array>, meta?: FsMeta & AudioMeta): Promise<void> =>
	(await nativeCaches).audio.store(url, dataStream, meta);
export const audioStreamsStatus = async (url: string): Promise<AudioStreamStatus> => (await nativeCaches).audio.status(url);

/** The cache of `key` once every main process cache is made and loaded */
const cacheOf = async (key: string) => {
	await nativeCaches;
	const cache = Cache.caches.get(key);
	if (cache === undefined) throw new Error(`No main process cache ${key}`);
	await cache.ready;
	return cache;
};

export const cacheList = async (): Promise<CacheStats[]> => {
	await nativeCaches;
	return Promise.all([...Cache.caches.keys()].map(async (key) => (await cacheOf(key)).stats()));
};
export const cacheStats = async (key: string): Promise<CacheStats> => (await cacheOf(key)).stats();
/** Bytes the cache may hold, `undefined` for its default. Resolves once what no longer fits is evicted */
export const cacheSetLimit = async (key: string, bytes?: number): Promise<void> => (await cacheOf(key)).setUserBytesLimit(bytes);
/** Deletes every entry of the cache that isn't in use */
export const cacheClear = async (key: string): Promise<void> => (await cacheOf(key)).clear();
/** Opens the folder of the cache's files, `undefined` if it has none */
export const cacheOpenLocation = async (key: string): Promise<string | undefined> => {
	const location = (await cacheOf(key)).stats().persist?.data.location;
	if (location) return electron.shell.openPath(location);
};

// The page shows main process caches through NativeCache (plugins/lib), live
Cache.onAnyStats(new Set(), (stats) => globalThis.luna?.sendToRender?.("__Luna.cacheStats", stats));
Cache.onControlAdded(new Set(), (control) => globalThis.luna?.sendToRender?.("__Luna.cacheAdded", control.key));
