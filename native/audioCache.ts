// Audio cache. TIDAL's native player (TIDALPlayer.exe) fetches audio itself from a url TIDAL sends it over stdin (media.load / media.preload),
// so Luna can't see that traffic. Those messages are rewritten (rewritePlayerMessage) to point at a loopback server here, which serves the audio
// from the cache, and anything else in the main process can read audio through it too (audioCacheUrl, e.g. MediaItem downloads).
// - Active / partial audio entries are filled in memory by ranged fetches in any order, the bytes held are tracked in memory.
// - Requests are answered as bytes arrive. A read of bytes nothing is fetching soon starts fetching from there (instant seeks).
// - Wanted entries (the player's track, the renderer's window, hovered tracks) are filled in the background, only the most important at a time.
// - Once a wanted track is completely in memory, @luna/lib persists it to disk via MediaItem.download (decrypted, tagged and named from its tags)
//   with an <id>.json sidecar. Persisted files are served directly from disk with encryptionKey cleared, until evicted (least recently / frequently
//   played first, see cache/DiskCache.ts) when over the limit.
import electron from "electron";

import { createHash, randomBytes } from "crypto";
import { constants } from "fs";
import { open, type FileHandle } from "fs/promises";
import http from "http";
import path from "path";

import { DiskCache } from "./cache/DiskCache";

const audioHost = /^[\w-]+\.audio\.tidal\.com$/;
const GB = 1024 ** 3;
/** Bytes of a hovered track fetched ahead, what the player reads first */
const hoverBytes = 2 * 1024 ** 2;
/** A read waits for a fetch that will reach it within this many bytes, rather than starting another */
const waitBytes = 1024 ** 2;
const maxFailures = 3;

type Range = [start: number, end: number];
type Fetch = { pos: number; end: number };
type Entry = {
	id: string;
	/** Latest url seen for this audio, its token is what the CDN accepts */
	url: string;
	size?: number;
	type: string;
	/** Raw CDN bytes held in memory while active */
	data?: Buffer;
	/** Sorted, merged, end exclusive */
	have: Range[];
	complete: boolean;
	persisting?: boolean;
	fetches: Set<Fetch>;
	filling?: Promise<void>;
	/** Where a read wants the fill to continue from */
	want?: number;
	/** Reads blocked on bytes */
	waiting: number;
	readers: number;
	failures: number;
	error?: unknown;
	waiters: Set<() => void>;
};
/** What the sidecar of a persisted track says: its file in the cache folder and content type */
type Meta = { file: string; type: string };
/** What `DiskCacheStats.extra` holds for the audio cache */
export type AudioCacheExtra = {
	servedBytes: number;
	fetchedBytes: number;
	fetching: { id: string; priority: number; held: number; size?: number }[];
};
/** Open file of a persisted track, shared by the reads of it */
type DiskHandle = { refs: number; handle?: Promise<FileHandle> };

const entries = new Map<string, Entry>();
const handles = new Map<string, DiskHandle>();
const stats = { servedBytes: 0, fetchedBytes: 0 };

let currentId: string | undefined;
let currentMem = false;
let preloadId: string | undefined;
let preloadMem = false;
let windowIds: string[] = [];
/** Latest first */
let hoverIds: string[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Keyed by path, the token in the query changes
const idOf = (rawUrl: string) => {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return;
	}
	if (url.protocol !== "https:" || !audioHost.test(url.hostname)) return;
	return createHash("sha1").update(url.pathname).digest("hex").slice(0, 32);
};

// Tokens are `<expiry epoch seconds>~<signature>`
const expiryOf = (rawUrl: string) => Number(new URL(rawUrl).searchParams.get("token")?.split("~")[0]) || 0;

const openEntry = (rawUrl: string): Entry | undefined => {
	const id = idOf(rawUrl);
	if (id === undefined) return;
	let entry = entries.get(id);
	if (entry === undefined) {
		entry = {
			...{ id, url: rawUrl, size: disk.bytesOf(id), type: disk.meta(id)?.type ?? "application/octet-stream", have: [], complete: false },
			...{ fetches: new Set(), waiters: new Set(), waiting: 0, readers: 0, failures: 0 },
		};
		entries.set(id, entry);
	}
	// A url someone held on to (e.g. a memoized playbackinfo) doesn't replace a newer one
	if (expiryOf(rawUrl) >= expiryOf(entry.url)) entry.url = rawUrl;
	entry.failures = 0;
	entry.error = undefined;
	return entry;
};

// Byte ranges
const addRange = (have: Range[], start: number, end: number) => {
	let i = 0;
	while (i < have.length && have[i][1] < start) i++;
	let j = i;
	for (; j < have.length && have[j][0] <= end; j++) {
		start = Math.min(start, have[j][0]);
		end = Math.max(end, have[j][1]);
	}
	have.splice(i, j - i, [start, end]);
};
/** End of the bytes held from `pos` on, `pos` if it isn't held */
const heldUntil = (have: Range[], pos: number) => {
	for (const [start, end] of have) if (start <= pos && pos < end) return end;
	return pos;
};
/** The first missing range from `pos` on, before `limit` */
const gapFrom = (have: Range[], pos: number, limit: number): Range | undefined => {
	for (const [start, end] of have) {
		if (end <= pos) continue;
		if (start > pos) return pos < limit ? [pos, Math.min(start, limit)] : undefined;
		pos = end;
	}
	return pos < limit ? [pos, limit] : undefined;
};
const heldBytes = (have: Range[]) => have.reduce((sum, [start, end]) => sum + end - start, 0);

const isMemPinned = (entry: Entry) => (entry.id === currentId && currentMem) || (entry.id === preloadId && preloadMem);

// Priorities, only fetches of the most important entries proceed
const wantedBytes = (entry: Entry) => {
	if (disk.has(entry.id) && !isMemPinned(entry)) return 0;
	if (entry.id === currentId || entry.id === preloadId || windowIds.includes(entry.id)) return Infinity;
	return hoverIds.includes(entry.id) ? hoverBytes : 0;
};
const priorityOf = (entry: Entry) => {
	if (entry.waiting > 0) return 5;
	if (entry.id === currentId) return 4;
	if (entry.id === hoverIds[0]) return 3;
	if (entry.id === preloadId) return 2;
	const windowIndex = windowIds.indexOf(entry.id);
	if (windowIndex !== -1) return 2 - windowIndex / 10;
	return hoverIds.includes(entry.id) ? 1 : 0;
};
const active = new Set<Entry>();
const gateWaiters = new Set<() => void>();
const regate = () => {
	for (const waiter of gateWaiters) waiter();
	gateWaiters.clear();
};
const isTop = (entry: Entry) => {
	const priority = priorityOf(entry);
	for (const other of active) if (priorityOf(other) > priority) return false;
	return true;
};
const gate = async (entry: Entry) => {
	while (!isTop(entry)) await new Promise<void>((resolve) => gateWaiters.add(resolve));
};

const wake = (entry: Entry) => {
	for (const waiter of entry.waiters) waiter();
	entry.waiters.clear();
};

/** Releases an entry's in-memory buffer once it is persisted on disk or no longer wanted and has no active memory readers */
const maybeFreeMemory = (entry: Entry) => {
	if (entry.data === undefined) return;
	if (entry.readers > 0 || entry.fetches.size > 0 || entry.persisting || isMemPinned(entry)) return;
	if (disk.has(entry.id) || wantedBytes(entry) === 0) {
		entry.data = undefined;
		entry.have = [];
		entry.complete = false;
	}
};
const trimMemory = () => {
	for (const entry of entries.values()) maybeFreeMemory(entry);
};

const acquireDisk = (id: string) => {
	const onDisk = handles.get(id) ?? { refs: 0 };
	handles.set(id, onDisk);
	onDisk.refs++;
	return (onDisk.handle ??= open(disk.fileOf(disk.fileNameOf(id)!), constants.O_RDONLY));
};
const releaseDisk = (id: string) => {
	const onDisk = handles.get(id)!;
	if (--onDisk.refs !== 0) return;
	handles.delete(id);
	onDisk.handle?.then((fh) => fh.close()).catch(() => {});
};

// Complete, decrypted and tagged files persisted on disk, with an <id>.json sidecar naming the file. The cache folder is the DiskCache's: only
// files with a valid sidecar are kept, orphans and legacy raw files are dropped, and what no longer fits is evicted
const disk = new DiskCache<Meta>({
	name: "audio",
	defaultLimit: 128 * GB,
	// It never takes more than 75% of the free disk space
	freeShare: 0.75,
	bodyOf: (_, meta) => meta.file,
	isPinned: (id) => {
		const entry = entries.get(id);
		return (
			(handles.get(id)?.refs ?? 0) > 0 ||
			id === currentId ||
			id === preloadId ||
			windowIds.includes(id) ||
			(entry !== undefined && (entry.readers > 0 || entry.persisting === true))
		);
	},
	extraStats: (): AudioCacheExtra => ({
		...stats,
		fetching: [...active].map((entry) => ({ id: entry.id, priority: priorityOf(entry), held: heldBytes(entry.have), size: entry.size })),
	}),
});
const ready = disk.ready;

const isAbort = (err: unknown) => err instanceof Error && err.name === "AbortError";
/** Fetches [start, end) into `entry.data` in memory while `keepGoing`, in turn with other entries' fetches by priority */
const fetchRange = async (entry: Entry, start: number, end: number, keepGoing: () => boolean) => {
	const job: Fetch = { pos: start, end };
	const abort = new AbortController();
	entry.fetches.add(job);
	active.add(entry);
	try {
		await gate(entry);
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
		if (entry.data === undefined) {
			entry.size = size;
			entry.type = res.headers.get("content-type") ?? entry.type;
			entry.data = Buffer.allocUnsafe(size);
		}
		job.end = Math.min(job.end, entry.size!);
		wake(entry);
		for await (const chunk of <AsyncIterable<Uint8Array>>(<unknown>res.body)) {
			// An unread response holds its connection (and HTTP/2 window) from the fetches outranking it, so drop it, fill resumes when on top
			if (!keepGoing() || !isTop(entry)) break;
			const length = Math.min(chunk.byteLength, job.end - job.pos);
			entry.data.set(chunk.subarray(0, length), job.pos);
			addRange(entry.have, job.pos, job.pos + length);
			job.pos += length;
			stats.fetchedBytes += length;
			entry.failures = 0;
			wake(entry);
			if (job.pos >= job.end) break;
		}
		if (!entry.complete && entry.size !== undefined && heldUntil(entry.have, 0) >= entry.size) {
			entry.complete = true;
			wake(entry);
		}
	} finally {
		abort.abort();
		entry.fetches.delete(job);
		if (entry.fetches.size === 0) active.delete(entry);
		maybeFreeMemory(entry);
		regate();
		wake(entry);
	}
};
const failed = (entry: Entry, err: unknown) => {
	if (isAbort(err)) return;
	entry.error = err;
	if (++entry.failures === maxFailures) console.error(`[Luna.native] [AudioCache] ${entry.id}`, err);
};

/** Fills a wanted entry in memory in the background, from where a read wants it or the start */
const fill = (entry: Entry) => {
	if (wantedBytes(entry) === 0) return;
	return (entry.filling ??= (async () => {
		while (entry.failures < maxFailures) {
			const from = entry.want ?? 0;
			entry.want = undefined;
			const wanted = Math.min(wantedBytes(entry), entry.size ?? Infinity);
			const gap = gapFrom(entry.have, from, wanted) ?? gapFrom(entry.have, 0, wanted);
			if (gap === undefined) break;
			await fetchRange(entry, ...gap, () => entry.want === undefined && wantedBytes(entry) > 0).catch(async (err) => {
				failed(entry, err);
				await sleep(1000);
			});
		}
	})().finally(() => {
		entry.filling = undefined;
		maybeFreeMemory(entry);
		// Reads waiting on a fill that stopped short (e.g. the track is no longer wanted) ask again
		wake(entry);
	}));
};

/** Resolves once there are new bytes (or an error) for a read at `pos` */
const need = async (entry: Entry, pos: number) => {
	if (entry.failures >= maxFailures) throw entry.error;
	let soon = false;
	for (const job of entry.fetches) if (job.pos <= pos && pos < Math.min(job.end, job.pos + waitBytes)) soon = true;
	if (!soon) {
		if (wantedBytes(entry) === Infinity) {
			entry.want = pos;
			fill(entry);
		} else {
			if (entry.failures > 0) await sleep(1000);
			const end = gapFrom(entry.have, pos, entry.size ?? Infinity)?.[1] ?? pos;
			fetchRange(entry, pos, end, () => entry.readers > 0 || wantedBytes(entry) > 0).catch((err) => failed(entry, err));
		}
	}
	if (entry.waiting++ === 0) regate();
	await new Promise<void>((resolve) => entry.waiters.add(resolve));
	if (--entry.waiting === 0) regate();
};

const parseRange = (header: string | undefined, size: number): Range | undefined => {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
	if (match === null) return;
	let start = match[1] === "" ? size - Number(match[2]) : Number(match[1]);
	const end = match[1] === "" || match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
	start = Math.max(0, start);
	if (start > end) return;
	return [start, end];
};

const waitDrain = (res: http.ServerResponse) =>
	new Promise<void>((resolve) => {
		const done = () => (res.off("drain", done), res.off("close", done), resolve());
		res.on("drain", done).on("close", done);
	});

// Only who is given a url can read through the server
const secret = randomBytes(16).toString("hex");
const serve = async (req: http.IncomingMessage, res: http.ServerResponse) => {
	await ready;
	const [, urlSecret, mode, id] = (req.url ?? "").split("/");
	if (urlSecret !== secret) return void res.writeHead(404).end();

	if (mode === "disk") {
		const onDisk = disk.meta(id);
		const size = disk.bytesOf(id);
		if (onDisk === undefined || size === undefined) return void res.writeHead(404).end();
		disk.touch(id);
		const fh = acquireDisk(id);
		try {
			const rangeHeader = req.headers.range;
			const range = parseRange(rangeHeader, size);
			if (rangeHeader !== undefined && range === undefined) return void res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
			const [start, end] = range ?? [0, size - 1];
			res.writeHead(range ? 206 : 200, {
				"Content-Type": onDisk.type,
				"Content-Length": end - start + 1,
				"Accept-Ranges": "bytes",
				"X-Luna-Decrypted": "1",
				...(range && { "Content-Range": `bytes ${start}-${end}/${size}` }),
			});
			if (req.method === "HEAD") return void res.end();

			for (let pos = start; pos <= end && !res.destroyed;) {
				const buffer = Buffer.allocUnsafe(Math.min(end + 1 - pos, 1024 ** 2));
				const { bytesRead } = await (await fh).read(buffer, 0, buffer.length, pos);
				if (bytesRead === 0) throw new Error(`Audio file ${onDisk.file} is shorter than expected`);
				stats.servedBytes += bytesRead;
				pos += bytesRead;
				if (!res.write(buffer.subarray(0, bytesRead))) await waitDrain(res);
			}
			res.end();
		} finally {
			releaseDisk(id);
		}
		return;
	}

	const entry = mode === "mem" ? entries.get(id) : undefined;
	if (entry === undefined) return void res.writeHead(404).end();

	entry.readers++;
	// A read blocked on bytes outranks every other fetch, it must not outlive its connection
	const onClose = () => wake(entry);
	res.once("close", onClose);
	try {
		const rangeHeader = req.headers.range;
		const requestedStart = Number(/^bytes=(\d+)-/.exec(rangeHeader ?? "")?.[1] ?? 0);
		while (entry.data === undefined || entry.size === undefined) await need(entry, requestedStart);
		const size = entry.size;
		const range = parseRange(rangeHeader, size);
		if (rangeHeader !== undefined && range === undefined) return void res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
		const [start, end] = range ?? [0, size - 1];
		res.writeHead(range ? 206 : 200, {
			"Content-Type": entry.type,
			"Content-Length": end - start + 1,
			"Accept-Ranges": "bytes",
			...(range && { "Content-Range": `bytes ${start}-${end}/${size}` }),
		});
		if (req.method === "HEAD") return void res.end();

		for (let pos = start; pos <= end && !res.destroyed;) {
			const held = Math.min(heldUntil(entry.have, pos), end + 1);
			if (held === pos) {
				await need(entry, pos);
				continue;
			}
			if (entry.data === undefined) throw new Error(`Audio memory buffer for ${entry.id} was released while reading`);
			const chunk = entry.data.subarray(pos, Math.min(held, pos + 1024 ** 2));
			stats.servedBytes += chunk.byteLength;
			pos += chunk.byteLength;
			if (!res.write(chunk)) await waitDrain(res);
		}
		res.end();
	} finally {
		res.off("close", onClose);
		entry.readers--;
		maybeFreeMemory(entry);
	}
};

let port: number | undefined;
const server = http.createServer((req, res) => {
	serve(req, res).catch((err) => res.destroy(err));
});
server.on("listening", () => (port = (<{ port: number }>server.address()).port));
server.on("error", (err) => console.error("[Luna.native] [AudioCache] server error, playing from TIDAL's urls", err));
server.listen(0, "127.0.0.1").unref();

const loopbackUrl = (entry: Entry, mode: "disk" | "mem") =>
	// Named like the original so readers still see the file extension
	`http://127.0.0.1:${port}/${secret}/${mode}/${entry.id}/${path.posix.basename(new URL(entry.url).pathname)}`;

/** Points the audio url of a message to TIDAL's player at the cache. Messages that aren't audio loads pass through */
export const rewritePlayerMessage = (message: string) => {
	if (port === undefined || !/"media\.(load|preload|recover)"/.test(message)) return message;
	try {
		const parsed = JSON.parse(message);
		const entry = typeof parsed.url === "string" ? openEntry(parsed.url) : undefined;
		if (entry === undefined) return message;
		const fromDisk = parsed.command === "media.recover" && entry.id === currentId ? !currentMem && disk.has(entry.id) : disk.has(entry.id);
		if (parsed.command === "media.preload") {
			preloadId = entry.id;
			preloadMem = !fromDisk;
		} else {
			currentId = entry.id;
			currentMem = !fromDisk;
		}
		trimMemory();
		regate();
		if (!fromDisk) fill(entry);
		return JSON.stringify({
			...parsed,
			url: loopbackUrl(entry, fromDisk ? "disk" : "mem"),
			...(fromDisk && { encryptionKey: "" }),
		});
	} catch {
		return message;
	}
};

/** A url serving the audio at `url` (https://*.audio.tidal.com) through the cache, which supports ranges. `undefined` for other urls */
export const audioCacheUrl = (url: string) => {
	const entry = port === undefined ? undefined : openEntry(url);
	return entry && loopbackUrl(entry, disk.has(entry.id) ? "disk" : "mem");
};

/** The audio urls to fetch in the background, in priority order, e.g. of the current, next and previous track */
export const audioCacheWindow = (urls: string[]) => {
	const window = urls.map(openEntry).filter((entry) => entry !== undefined);
	windowIds = window.map((entry) => entry.id);
	trimMemory();
	regate();
	window.forEach(fill);
};

/** Fetches the start of a hovered track's audio ahead of all but what is playing. The latest hover goes first, older ones after the window */
export const audioCacheHover = (url: string) => {
	const entry = openEntry(url);
	if (entry === undefined) return;
	hoverIds = [entry.id, ...hoverIds.filter((id) => id !== entry.id)].slice(0, 4);
	trimMemory();
	regate();
	fill(entry);
};

/**
 * Waits until `url` has completely filled in memory and needs to be persisted to disk.
 * Returns the cache folder path when ready to persist, or `undefined` if already on disk or no longer wanted.
 */
export const audioCacheWaitFilled = async (url: string): Promise<string | undefined> => {
	await ready;
	const entry = openEntry(url);
	if (entry === undefined || disk.has(entry.id)) return;
	while (!entry.complete && !disk.has(entry.id)) {
		if (entry.failures >= maxFailures || wantedBytes(entry) < Infinity) return;
		fill(entry);
		await new Promise<void>((resolve) => entry.waiters.add(resolve));
	}
	if (disk.has(entry.id) || !entry.complete || entry.data === undefined) return;
	entry.persisting = true;
	return disk.dir;
};

/**
 * Registers a track file written by `MediaItem.download` into the on-disk cache with its `<id>.json` sidecar,
 * and releases the in-memory buffer once no longer needed.
 */
export const audioCachePersist = async (url: string, filePath?: string): Promise<void> => {
	await ready;
	const id = idOf(url);
	if (id === undefined) return;
	const entry = entries.get(id);
	try {
		if (filePath === undefined) return;
		const type = entry?.type && entry.type !== "application/octet-stream" ? entry.type : "audio/flac";
		// The file is in the cache folder, MediaItem.download wrote it there
		await disk.adopt(id, { file: path.basename(filePath), type });
	} finally {
		if (entry !== undefined) {
			entry.persisting = false;
			maybeFreeMemory(entry);
			wake(entry);
		}
	}
};

export type AudioCacheStatus = { size?: number; held: number; complete: boolean };
export const audioCacheStatus = (url: string): AudioCacheStatus => {
	const id = idOf(url);
	const onDisk = id === undefined ? undefined : disk.bytesOf(id);
	if (onDisk !== undefined) return { size: onDisk, held: onDisk, complete: true };
	const entry = id === undefined ? undefined : entries.get(id);
	if (entry === undefined) return { size: undefined, held: 0, complete: false };
	return { size: entry.size, held: heldBytes(entry.have), complete: entry.complete };
};
