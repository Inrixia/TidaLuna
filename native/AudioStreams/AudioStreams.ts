// Audio streams and cache. TIDAL's native player (TIDALPlayer.exe) fetches audio itself from a url TIDAL sends it over stdin
// (media.load / media.preload), so Luna can't see that traffic. Those messages are rewritten (rewritePlayerMessage) to point at a loopback
// server, which serves either:
// - `/cache/<id>/<name>` when the track is already cached: decrypted, tagged bytes streamed from `this.cache` (StreamBufferBackend in memory +
//   FsBackend on disk, always identical bytes and meta across tiers), with `encryptionKey` cleared.
// - `/live/<id>/<name>` while uncached: encrypted CDN bytes fetched by range into a live `StreamBuffer` owned by `AudioStreams`, with instant
//   out-of-order seeks and priority gating (waiting reader > playing > latest hover > preload > queue window > older hover).
// Once a wanted track's live buffer fills, `lib` streams it once from `/live/<id>`, decrypts and tags it, and stores it via `store(...)`
// into `this.cache.setStream(...)`. The CDN is hit once.
import { sleep } from "@inrixia/helpers";
import electron from "electron";
import http from "http";
import path from "path";
import sanitize from "sanitize-filename";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

import { StreamBuffer, type Cache, type CacheStore, type MapBackend, type MetaBackend, type StreamBufferBackend } from "../../cache";
import type { FsBackend, FsMeta } from "../cache/FsBackend";
import { nativeTrace } from "../trace";
import { writeHead } from "./AudioStreams.http";
import { audioIdOf, expiryOf } from "./AudioStreams.urls";

/** Stored beside `FsMeta.path` for every cached audio stream */
export type AudioMeta = { type: string };
/** How much of a track's audio is cached or buffered live */
export type AudioStreamStatus = { size?: number; cachedBytes: number; complete: boolean };
export type AudioStreamsCache = Cache<CacheStore<MapBackend, StreamBufferBackend>, CacheStore<MetaBackend<true>, FsBackend<AudioMeta>>>;

/** A CDN range fetch running now, at `pos` going to `end` (exclusive) */
type Fetch = { pos: number; end: number };
/** Encrypted CDN audio being streamed or filled live before it is decrypted, tagged and stored in `cache` */
type LiveStream = {
	id: string;
	/** Latest url seen for this audio, its token is what the CDN accepts */
	url: string;
	type: string;
	buffer: StreamBuffer;
	fetches: Set<Fetch>;
	filling?: Promise<void>;
	/** Where a reader wants the fill to continue from */
	want?: number;
	/** Being decrypted, tagged and streamed into `cache`, so its live bytes stay pinned until stored */
	persisting: boolean;
	failures: number;
	error?: unknown;
};

const MiB = 1024 ** 2; // 1 MiB
/** Bytes of a hovered track fetched ahead (2 MiB), what the player reads first */
const hoverBytes = 2 * MiB;
/** A reader waits for a fetch that will reach it within 1 MiB rather than starting another */
const waitBytes = MiB;
/** Fetching a track stops after this many failures in a row, until it is asked for again */
const maxFailures = 3;
const isAbort = (err: unknown) => err instanceof Error && err.name === "AbortError";
/** Sanitizes each `/`-delimited segment of `relativePath` so `FsBackend` stores and SQLite records the exact same path */
const cleanAudioPath = (relativePath: string): string => {
	if (relativePath === "" || path.isAbsolute(relativePath) || /^[\\/]/.test(relativePath)) return "";
	const parts = relativePath.split("/").map((part) => {
		if (part === "" || part === "..") return "";
		return sanitize(part) || "_";
	});
	return parts.includes("") ? "" : parts.join("/");
};

export class AudioStreams {
	private static readonly trace = nativeTrace.withSource("[AudioStreams]");

	private readonly unloads = new Set<() => void>();
	private readonly server: http.Server;
	/** The loopback server's port once it listens */
	private port?: number;
	/** Resolves once the loopback server is listening */
	public readonly listening: Promise<void>;

	private readonly live = new Map<string, LiveStream>();
	/** Live entries actively fetching from the CDN now */
	private readonly fetching = new Set<LiveStream>();
	private servedBytes = 0;
	private fetchedBytes = 0;

	// What the player plays and the page wants next, by stream id
	private currentId?: string;
	/** The playing session started on `/live` (untagged, encrypted), so seeks/recovers stay on `/live` even after `/cache` lands */
	private currentFromLive = false;
	private preloadId?: string;
	private preloadFromLive = false;
	private windowIds: string[] = [];
	/** Latest first */
	private hoverIds: string[] = [];

	/** Fetches waiting for higher-priority ones to finish, see `gate` */
	private readonly gateWaiters = new Set<() => void>();

	public constructor(public readonly cache: AudioStreamsCache) {
		cache.attach(
			{
				// Never take more than 75% of the free disk space plus what this cache already holds
				maxBytesLimit: () => {
					const freeBytes = cache.persistStore.dataBackend.stats().freeBytes;
					return freeBytes === undefined ? Infinity : 0.75 * (freeBytes + cache.persistStore.bytes);
				},
				// Pin playing, preloaded and window tracks, plus any entry whose live buffer is still being read or persisted
				isPinned: (id) => {
					if (id === this.currentId || id === this.preloadId || this.windowIds.includes(id)) return true;
					const live = this.live.get(id);
					return live !== undefined && (live.buffer.readers > 0 || live.persisting);
				},
				stats: () => {
					let liveStreams = 0;
					let liveBytes = 0;
					for (const entry of this.live.values()) {
						if (entry.buffer.data === undefined) continue;
						liveStreams++;
						liveBytes += entry.buffer.filledBytes;
					}
					return {
						liveStreams,
						liveBytes,
						activeFetches: this.fetching.size,
						fetchedBytes: this.fetchedBytes,
						servedBytes: this.servedBytes,
					};
				},
			},
			this.unloads,
		);

		// Files no meta names (e.g. written just before a crash ahead of flush) are deleted
		cache.ready
			.then(() => {
				const persist = cache.persistStore;
				return Promise.all(persist.orphans.map((file) => persist.dataBackend.deleteFile(file)));
			})
			.catch(AudioStreams.trace.warn.withContext("Failed to delete stray audio files"));

		const server = http.createServer((req, res) => {
			this.serve(req, res).catch((err) => res.destroy(err));
		});
		this.server = server;
		this.listening = new Promise<void>((resolve) => {
			server.on("listening", () => {
				this.port = (<{ port: number }>server.address()).port;
				resolve();
			});
		});
		server.on("error", AudioStreams.trace.err.withContext("server error, playing from TIDAL's urls"));
		server.listen(0, "127.0.0.1").unref();
	}

	/** Stops the loopback server and detaches hooks */
	public close(): Promise<void> {
		for (const unload of this.unloads) unload();
		this.unloads.clear();
		return new Promise((resolve) => this.server.close(() => resolve()));
	}

	/** The live entry for `rawUrl`, made if new. `undefined` if `rawUrl` isn't a TIDAL audio url */
	private entryOf(rawUrl: string): LiveStream | undefined {
		const id = audioIdOf(rawUrl);
		if (id === undefined) return;
		let entry = this.live.get(id);
		if (entry === undefined) {
			const created: LiveStream = {
				id,
				url: rawUrl,
				type: this.cache.meta(id)?.type ?? "application/octet-stream",
				buffer: new StreamBuffer({
					onWait: (pos) => this.need(created, pos),
					onWaitingChange: () => this.regate(),
					onRelease: () => this.freeMemory(created),
				}),
				fetches: new Set(),
				persisting: false,
				failures: 0,
			};
			this.live.set(id, (entry = created));
		}
		// A url someone held on to (e.g. an older playbackinfo) doesn't replace a fresher token
		if (expiryOf(rawUrl) >= expiryOf(entry.url)) entry.url = rawUrl;
		entry.failures = 0;
		entry.error = undefined;
		return entry;
	}

	/** Loopback url serving `entry` from `cache` (decrypted, tagged) or `live` (encrypted CDN bytes) */
	private loopbackUrl(entry: LiveStream, mode: "cache" | "live") {
		// Named like the original so readers still see the file extension
		return `http://127.0.0.1:${this.port}/${mode}/${entry.id}/${path.posix.basename(new URL(entry.url).pathname)}`;
	}

	/** Priority order: waiting reader (5) > playing (4) > latest hover (3) > preload (2) > queue window (2 - i/10) > older hover (1) */
	private priorityOf(entry: LiveStream) {
		if (entry.buffer.waiting > 0) return 5;
		if (entry.id === this.currentId) return 4;
		if (entry.id === this.hoverIds[0]) return 3;
		if (entry.id === this.preloadId) return 2;
		const windowIndex = this.windowIds.indexOf(entry.id);
		if (windowIndex !== -1) return 2 - windowIndex / 10;
		return this.hoverIds.includes(entry.id) ? 1 : 0;
	}
	/** Active player or preload session started on `/live`, so its live buffer stays until the track changes */
	private playsFromLive(entry: LiveStream) {
		return (entry.id === this.currentId && this.currentFromLive) || (entry.id === this.preloadId && this.preloadFromLive);
	}
	/** Bytes of `entry` to fetch into the live buffer in the background, `Infinity` for all of it */
	private wantedBytes(entry: LiveStream) {
		if (this.cache.has(entry.id) && !this.playsFromLive(entry)) return 0;
		if (entry.id === this.currentId || entry.id === this.preloadId || this.windowIds.includes(entry.id)) return Infinity;
		return this.hoverIds.includes(entry.id) ? hoverBytes : 0;
	}
	/** Drops `entry`'s live bytes once nothing reads, fetches or persists them, and they are cached or no longer wanted */
	private freeMemory(entry: LiveStream) {
		const buffer = entry.buffer;
		if (buffer.data === undefined || buffer.readers > 0 || entry.fetches.size > 0 || entry.persisting || this.playsFromLive(entry)) return;
		if (this.cache.has(entry.id) || this.wantedBytes(entry) === 0) buffer.clear();
	}
	private wantedChanged() {
		for (const entry of this.live.values()) this.freeMemory(entry);
		this.regate();
	}

	private regate() {
		for (const waiter of this.gateWaiters) waiter();
		this.gateWaiters.clear();
	}
	private isTop(entry: LiveStream) {
		const priority = this.priorityOf(entry);
		for (const other of this.fetching) if (this.priorityOf(other) > priority) return false;
		return true;
	}
	private async gate(entry: LiveStream) {
		while (!this.isTop(entry)) await new Promise<void>((resolve) => this.gateWaiters.add(resolve));
	}

	/** Fetches `[start, end)` of `entry` into its live buffer while `keepGoing`, gated by priority */
	private async fetchRange(entry: LiveStream, start: number, end: number, keepGoing: () => boolean) {
		const job: Fetch = { pos: start, end };
		const abort = new AbortController();
		const buffer = entry.buffer;
		entry.fetches.add(job);
		this.fetching.add(entry);
		try {
			await this.gate(entry);
			if (!keepGoing()) return;
			const res = await electron.net.fetch(entry.url, {
				headers: { Range: `bytes=${start}-${end === Infinity ? "" : end - 1}` },
				signal: abort.signal,
				bypassCustomProtocolHandlers: true,
			});
			if (res.body === null || (res.status !== 206 && !(res.status === 200 && start === 0)))
				throw new Error(`Audio fetch failed, HTTP ${res.status}`);
			const size = Number(res.status === 206 ? res.headers.get("content-range")?.split("/")[1] : res.headers.get("content-length"));
			if (!(size > 0)) throw new Error("Audio fetch has no size");
			if (buffer.data === undefined) {
				entry.type = res.headers.get("content-type") ?? entry.type;
				buffer.allocate(Buffer.allocUnsafe(size));
			}
			job.end = Math.min(job.end, buffer.size!);
			for await (const chunk of <AsyncIterable<Uint8Array>>(<unknown>res.body)) {
				// Yield connection and HTTP/2 window immediately if a higher-priority entry arrives
				if (!keepGoing() || !this.isTop(entry)) break;
				const length = Math.min(chunk.byteLength, job.end - job.pos);
				buffer.write(job.pos, chunk.subarray(0, length));
				job.pos += length;
				this.fetchedBytes += length;
				entry.failures = 0;
				if (job.pos >= job.end) break;
			}
		} finally {
			abort.abort();
			entry.fetches.delete(job);
			if (entry.fetches.size === 0) this.fetching.delete(entry);
			this.freeMemory(entry);
			this.regate();
			buffer.wake();
		}
	}
	private failed(entry: LiveStream, err: unknown) {
		if (isAbort(err)) return;
		entry.error = err;
		if (++entry.failures === maxFailures) AudioStreams.trace.err(entry.id, err);
	}
	/** Fills a wanted entry's live buffer in the background, starting at `entry.want` or byte 0 */
	private fill(entry: LiveStream) {
		if (this.wantedBytes(entry) === 0) return;
		entry.filling ??= (async () => {
			while (entry.failures < maxFailures) {
				const from = entry.want ?? 0;
				entry.want = undefined;
				const wanted = Math.min(this.wantedBytes(entry), entry.buffer.size ?? Infinity);
				const gap = entry.buffer.gapFrom(from, wanted) ?? entry.buffer.gapFrom(0, wanted);
				if (gap === undefined) break;
				await this.fetchRange(entry, gap[0], gap[1], () => entry.want === undefined && this.wantedBytes(entry) > 0).catch(async (err) => {
					this.failed(entry, err);
					await sleep(1000);
				});
			}
		})().finally(() => {
			entry.filling = undefined;
			this.freeMemory(entry);
			entry.buffer.wake();
		});
	}
	/** Reader waiting at `pos`: start a range fetch there unless an in-flight fetch will reach `pos` within `waitBytes` */
	private async need(entry: LiveStream, pos: number) {
		if (entry.failures >= maxFailures) throw entry.error;
		for (const job of entry.fetches) if (job.pos <= pos && pos < Math.min(job.end, job.pos + waitBytes)) return;
		if (this.wantedBytes(entry) === Infinity) {
			entry.want = pos;
			return this.fill(entry);
		}
		if (entry.failures > 0) await sleep(1000);
		const end = entry.buffer.gapFrom(pos)?.[1] ?? pos;
		this.fetchRange(entry, pos, end, () => entry.buffer.readers > 0 || this.wantedBytes(entry) > 0).catch((err) => this.failed(entry, err));
	}

	/** Answers `/cache/<id>/<name>` from `this.cache`, `/live/<id>/<name>` from `this.live` */
	private async serve(req: http.IncomingMessage, res: http.ServerResponse) {
		await this.cache.ready;
		const [, mode, id] = (req.url ?? "").split("/");
		if (mode === "cache") return this.serveCache(req, res, id);
		const entry = mode === "live" ? this.live.get(id) : undefined;
		if (entry === undefined) return void res.writeHead(404).end();
		return this.serveLive(req, res, entry);
	}
	/** Serves decrypted, tagged audio from `this.cache` (memory tier if hot, persist tier otherwise) */
	private async serveCache(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
		const meta = this.cache.meta(id);
		if (meta === undefined || !this.cache.has(id)) return void res.writeHead(404).end();
		const range = writeHead(req, res, meta.bytes, { "Content-Type": meta.type, "X-Luna-Decrypted": "1" });
		if (range === undefined) return;
		if (req.method === "HEAD") return void (this.cache.touch(id), res.end());
		const gone = new AbortController();
		res.once("close", () => gone.abort());
		const stream = await this.cache.getStream(id, { start: range[0], end: range[1], signal: gone.signal });
		if (stream === undefined) throw new Error(`Cached audio ${id} was evicted while being read`);
		await this.send(stream, res);
	}
	/** Serves encrypted CDN bytes from the live `StreamBuffer` as they arrive */
	private async serveLive(req: http.IncomingMessage, res: http.ServerResponse, entry: LiveStream) {
		const release = entry.buffer.hold();
		const gone = new AbortController();
		res.once("close", () => gone.abort());
		try {
			const requestedStart = Number(/^bytes=(\d+)-/.exec(req.headers.range ?? "")?.[1] ?? 0);
			const size = await entry.buffer.sizeFrom(requestedStart, gone.signal);
			if (size === undefined) return;
			const range = writeHead(req, res, size, { "Content-Type": entry.type });
			if (range === undefined) return;
			if (req.method === "HEAD") return void res.end();
			await this.send(entry.buffer.stream(range[0], range[1] + 1, gone.signal), res);
		} finally {
			release();
		}
	}
	private async send(stream: ReadableStream<Uint8Array>, res: http.ServerResponse) {
		const readable = Readable.fromWeb(<import("stream/web").ReadableStream<Uint8Array>>stream);
		readable.on("data", (chunk: Uint8Array) => (this.servedBytes += chunk.byteLength));
		await pipeline(readable, res);
	}

	/** Rewrites a TIDAL native player command (`media.load`, `media.preload`, `media.recover`) to `/cache` or `/live` */
	public rewritePlayerMessage(message: string): string {
		if (this.port === undefined || !/"media\.(load|preload|recover)"/.test(message)) return message;
		try {
			const parsed = JSON.parse(message);
			const entry = typeof parsed.url === "string" ? this.entryOf(parsed.url) : undefined;
			if (entry === undefined) return message;
			// A recover of the playing track stays on the source (`live` vs `cache`) it started on so byte offsets match
			const fromCache =
				parsed.command === "media.recover" && entry.id === this.currentId
					? !this.currentFromLive && this.cache.has(entry.id)
					: this.cache.has(entry.id);
			if (parsed.command === "media.preload") {
				this.preloadId = entry.id;
				this.preloadFromLive = !fromCache;
			} else {
				this.currentId = entry.id;
				this.currentFromLive = !fromCache;
			}
			this.wantedChanged();
			if (!fromCache) this.fill(entry);
			parsed.url = this.loopbackUrl(entry, fromCache ? "cache" : "live");
			if (fromCache) parsed.encryptionKey = "";
			return JSON.stringify(parsed);
		} catch {
			return message;
		}
	}

	/** Loopback url serving `rawUrl` (`https://*.audio.tidal.com`) from `/cache` if complete, else `/live` */
	public url(rawUrl: string): string | undefined {
		const entry = this.port === undefined ? undefined : this.entryOf(rawUrl);
		return entry && this.loopbackUrl(entry, this.cache.has(entry.id) ? "cache" : "live");
	}
	/** Queue window urls to fill in the background, in priority order */
	public window(urls: string[]) {
		const window: LiveStream[] = [];
		for (const url of urls) {
			const entry = this.entryOf(url);
			if (entry !== undefined) window.push(entry);
		}
		this.windowIds = window.map((entry) => entry.id);
		this.wantedChanged();
		for (const entry of window) this.fill(entry);
	}
	/** Prefetches the first `hoverBytes` (2 MiB) of a hovered track ahead of all but the playing track */
	public hover(url: string) {
		const entry = this.entryOf(url);
		if (entry === undefined) return;
		this.hoverIds = [entry.id, ...this.hoverIds.filter((id) => id !== entry.id)].slice(0, 4);
		this.wantedChanged();
		this.fill(entry);
	}
	/**
	 * Waits until `url`'s live buffer is completely filled and ready to be decrypted, tagged and stored in `cache`.
	 * Resolves `true` (pinning the live buffer via `persisting = true` until `store` runs) or `false` if already cached or no longer wanted
	 */
	public async waitFilled(url: string): Promise<boolean> {
		await this.cache.ready;
		const entry = this.entryOf(url);
		if (entry === undefined || this.cache.has(entry.id)) return false;
		while (!entry.buffer.complete && !this.cache.has(entry.id)) {
			if (entry.failures >= maxFailures || this.wantedBytes(entry) < Infinity) return false;
			this.fill(entry);
			await entry.buffer.nextChange();
		}
		if (this.cache.has(entry.id) || !entry.buffer.complete) return false;
		entry.persisting = true;
		return true;
	}
	/**
	 * Streams decrypted, tagged audio `dataStream` for `url` into `this.cache` (both memory and persist tiers), then unpins and frees
	 * the untagged live buffer. Call without `dataStream` to release `persisting` when tagging/item lookup is skipped or fails
	 */
	public async store(url: string, dataStream?: ReadableStream<Uint8Array>, meta?: FsMeta & AudioMeta): Promise<void> {
		await this.cache.ready;
		const id = audioIdOf(url);
		if (id === undefined) return;
		const entry = this.live.get(id);
		try {
			if (dataStream === undefined || meta === undefined) return;
			const cleanPath = cleanAudioPath(meta.path);
			if (cleanPath === "") return;
			// If an older CDN path for the same track/quality already owns `cleanPath`, evict that stale key first so two keys never share one file
			for (const other of this.cache.keys()) {
				if (other !== id && this.cache.meta(other)?.path === cleanPath) await this.cache.delete(other);
			}
			const previousPath = this.cache.meta(id)?.path;
			const resolvedType = meta.type || (entry?.type && entry.type !== "application/octet-stream" ? entry.type : "audio/flac");
			await this.cache.setStream(id, dataStream, { meta: { path: cleanPath, type: resolvedType } });
			if (previousPath !== undefined && previousPath !== cleanPath) {
				await this.cache.persistStore.dataBackend.deleteFile(previousPath).catch(() => {});
			}
			// Flush meta immediately so a crash before the batched save doesn't leave an orphan file
			await this.cache.flush();
		} finally {
			if (entry !== undefined) {
				entry.persisting = false;
				this.freeMemory(entry);
				entry.buffer.wake();
			}
		}
	}
	public status(url: string): AudioStreamStatus {
		const id = audioIdOf(url);
		if (id === undefined) return { cachedBytes: 0, complete: false };
		const cachedMeta = this.cache.has(id) ? this.cache.meta(id) : undefined;
		if (cachedMeta !== undefined) return { size: cachedMeta.bytes, cachedBytes: cachedMeta.bytes, complete: true };
		const buffer = this.live.get(id)?.buffer;
		return { size: buffer?.size, cachedBytes: buffer?.filledBytes ?? 0, complete: buffer?.complete ?? false };
	}
}
