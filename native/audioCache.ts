// Audio cache. TIDAL's native player (TIDALPlayer.exe) fetches audio itself from a url TIDAL sends it over stdin (media.load / media.preload),
// so Luna can't see that traffic. Those messages are rewritten (rewritePlayerMessage) to point at a loopback server here, which serves the audio
// from the cache, and anything else in the main process can read audio through it too (audioCacheUrl, e.g. MediaItem downloads).
// - Each audio file is a file on disk filled by ranged fetches in any order, the bytes held are tracked in memory. The OS caches it in memory.
// - Requests are answered as bytes arrive. A read of bytes nothing is fetching soon starts fetching from there (instant seeks).
// - Wanted files (the player's track, the renderer's window, hovered tracks) are filled in the background, only the most important at a time.
// - Complete files are kept on disk until the cache is over its limit, then the least recently used go. Partial files go on restart.
// The bytes are kept as TIDAL serves them (OLD_AES encrypted for some), whoever reads them decrypts.
import electron from "electron";

import { createHash, randomBytes } from "crypto";
import { constants, readFileSync } from "fs";
import { mkdir, open, readdir, rm, stat, statfs, utimes, writeFile, type FileHandle } from "fs/promises";
import http from "http";
import path from "path";

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
	file: string;
	size?: number;
	type: string;
	/** Sorted, merged, end exclusive */
	have: Range[];
	complete: boolean;
	fetches: Set<Fetch>;
	filling?: Promise<void>;
	/** Where a read wants the fill to continue from */
	want?: number;
	/** Reads blocked on bytes */
	waiting: number;
	readers: number;
	refs: number;
	handle?: Promise<FileHandle>;
	failures: number;
	error?: unknown;
	waiters: Set<() => void>;
};

// Set when ready: reading userData fixes it, and it is derived from TIDAL's name which native/injector.ts sets after this module loads
let dir = "";
const entries = new Map<string, Entry>();
/** Complete files on disk */
const disk = new Map<string, { size: number; used: number }>();
let usage = 0;
let userLimit: number | undefined;
const stats = { servedBytes: 0, fetchedBytes: 0 };

let currentId: string | undefined;
let preloadId: string | undefined;
let windowIds: string[] = [];
/** Latest first */
let hoverIds: string[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fileOf = (id: string) => path.join(dir, id);
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
		const file = fileOf(id);
		entry = {
			...{ id, url: rawUrl, file, type: "application/octet-stream", have: [], complete: false },
			...{ fetches: new Set(), waiters: new Set(), waiting: 0, readers: 0, refs: 0, failures: 0 },
		};
		try {
			const meta = JSON.parse(readFileSync(file + ".json", "utf8"));
			Object.assign(entry, { size: meta.size, type: meta.type, have: [[0, meta.size]], complete: true });
		} catch {
			// Not on disk
		}
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

// Priorities, only fetches of the most important entries proceed
const wantedBytes = (entry: Entry) => {
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

const acquire = (entry: Entry) => {
	entry.refs++;
	return (entry.handle ??= ready.then(() => open(entry.file, constants.O_RDWR | constants.O_CREAT)));
};
const release = (entry: Entry) => {
	if (--entry.refs !== 0) return;
	const handle = entry.handle;
	entry.handle = undefined;
	handle?.then((fh) => fh.close()).catch(() => {});
};

const touch = (entry: Entry) => {
	const onDisk = disk.get(entry.id);
	if (onDisk === undefined) return;
	onDisk.used = Date.now();
	utimes(entry.file, new Date(), new Date()).catch(() => {});
};

const limit = async () => {
	let free = Infinity;
	try {
		const { bavail, bsize } = await statfs(dir);
		free = bavail * bsize;
	} catch {}
	return Math.min(userLimit ?? 128 * GB, 0.75 * (free + usage));
};
let pruning: Promise<void> | undefined;
/** Deletes the least recently used complete files until the cache is within its limit */
const prune = (): Promise<void> =>
	(pruning ??= (async () => {
		const max = await limit();
		if (usage <= max) return;
		for (const [id, { size }] of [...disk].sort(([, a], [, b]) => a.used - b.used)) {
			if (usage <= max) break;
			const entry = entries.get(id);
			if (entry !== undefined && (entry.refs > 0 || wantedBytes(entry) > 0)) continue;
			entries.delete(id);
			disk.delete(id);
			usage -= size;
			await rm(fileOf(id) + ".json", { force: true });
			await rm(fileOf(id), { force: true });
		}
	})()
		.catch((err) => console.error("[Luna.native] [AudioCache] Failed to prune", err))
		.finally(() => (pruning = undefined)));

// Partial files from a previous run are dropped, the bytes they hold aren't known
const ready = electron.app.whenReady().then(async () => {
	dir = path.join(electron.app.getPath("userData"), "luna-audio-cache");
	await mkdir(dir, { recursive: true });
	const names = new Set(await readdir(dir));
	await Promise.all(
		[...names].map(async (name) => {
			const id = name.endsWith(".json") ? name.slice(0, -5) : name;
			if (!names.has(id) || !names.has(`${id}.json`)) return rm(fileOf(name), { force: true });
			if (name !== id) return;
			const { size, mtimeMs } = await stat(fileOf(id));
			disk.set(id, { size, used: mtimeMs });
			usage += size;
		}),
	);
	await prune();
}).catch((err) => console.error("[Luna.native] [AudioCache] Failed to read the cache folder", err));

const completed = async (entry: Entry) => {
	entry.complete = true;
	await writeFile(entry.file + ".json", JSON.stringify({ size: entry.size, type: entry.type }));
	disk.set(entry.id, { size: entry.size!, used: Date.now() });
	usage += entry.size!;
	await prune();
};

const isAbort = (err: unknown) => err instanceof Error && err.name === "AbortError";
/** Fetches [start, end) into the file while `keepGoing`, in turn with other entries' fetches by priority */
const fetchRange = async (entry: Entry, start: number, end: number, keepGoing: () => boolean) => {
	const job: Fetch = { pos: start, end };
	const abort = new AbortController();
	entry.fetches.add(job);
	active.add(entry);
	try {
		const fh = await acquire(entry);
		try {
			await gate(entry);
			if (!keepGoing()) return;
			const res = await electron.net.fetch(entry.url, {
				headers: { Range: `bytes=${start}-${end === Infinity ? "" : end - 1}` },
				signal: abort.signal,
				bypassCustomProtocolHandlers: true,
			});
			if (res.body === null || (res.status !== 206 && !(res.status === 200 && start === 0))) throw new Error(`Audio fetch failed, HTTP ${res.status}`);
			const size = Number(res.status === 206 ? res.headers.get("content-range")?.split("/")[1] : res.headers.get("content-length"));
			if (!(size > 0)) throw new Error("Audio fetch has no size");
			if (entry.size === undefined) {
				entry.size = size;
				entry.type = res.headers.get("content-type") ?? entry.type;
			}
			job.end = Math.min(job.end, entry.size);
			wake(entry);
			for await (const chunk of <AsyncIterable<Uint8Array>>(<unknown>res.body)) {
				// An unread response holds its connection (and HTTP/2 window) from the fetches outranking it, so drop it, fill resumes when on top
				if (!keepGoing() || !isTop(entry)) break;
				const length = Math.min(chunk.byteLength, job.end - job.pos);
				await fh.write(chunk, 0, length, job.pos);
				addRange(entry.have, job.pos, job.pos + length);
				job.pos += length;
				stats.fetchedBytes += length;
				entry.failures = 0;
				wake(entry);
				if (job.pos >= job.end) break;
			}
		} finally {
			abort.abort();
			release(entry);
		}
		if (!entry.complete && heldUntil(entry.have, 0) >= entry.size!) await completed(entry);
	} finally {
		entry.fetches.delete(job);
		if (entry.fetches.size === 0) active.delete(entry);
		regate();
		wake(entry);
	}
};
const failed = (entry: Entry, err: unknown) => {
	if (isAbort(err)) return;
	entry.error = err;
	if (++entry.failures === maxFailures) console.error(`[Luna.native] [AudioCache] ${entry.id}`, err);
};

/** Fills a wanted entry in the background, from where a read wants it or the start */
const fill = (entry: Entry) =>
	(entry.filling ??= (async () => {
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
		// Reads waiting on a fill that stopped short (e.g. the track is no longer wanted) ask again
		wake(entry);
	}));

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

// Only who is given a url can read through the server
const secret = randomBytes(16).toString("hex");
const serve = async (req: http.IncomingMessage, res: http.ServerResponse) => {
	const [, urlSecret, id] = (req.url ?? "").split("/");
	const entry = urlSecret === secret ? entries.get(id) : undefined;
	if (entry === undefined) return void res.writeHead(404).end();

	entry.readers++;
	touch(entry);
	const fh = acquire(entry);
	// A read blocked on bytes outranks every other fetch, it must not outlive its connection
	const onClose = () => wake(entry);
	res.once("close", onClose);
	try {
		const rangeHeader = req.headers.range;
		const requestedStart = Number(/^bytes=(\d+)-/.exec(rangeHeader ?? "")?.[1] ?? 0);
		while (entry.size === undefined) await need(entry, requestedStart);
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

		for (let pos = start; pos <= end && !res.destroyed; ) {
			const held = Math.min(heldUntil(entry.have, pos), end + 1);
			if (held === pos) {
				await need(entry, pos);
				continue;
			}
			const buffer = Buffer.allocUnsafe(Math.min(held - pos, 1024 ** 2));
			const { bytesRead } = await (await fh).read(buffer, 0, buffer.length, pos);
			if (bytesRead === 0) throw new Error(`Audio file ${entry.id} is shorter than held`);
			stats.servedBytes += bytesRead;
			pos += bytesRead;
			if (!res.write(buffer.subarray(0, bytesRead)))
				await new Promise<void>((resolve) => {
					const done = () => (res.off("drain", done), res.off("close", done), resolve());
					res.on("drain", done).on("close", done);
				});
		}
		res.end();
	} finally {
		res.off("close", onClose);
		entry.readers--;
		release(entry);
	}
};

let port: number | undefined;
const server = http.createServer((req, res) => {
	serve(req, res).catch((err) => res.destroy(err));
});
server.on("listening", () => (port = (<{ port: number }>server.address()).port));
server.on("error", (err) => console.error("[Luna.native] [AudioCache] server error, playing from TIDAL's urls", err));
server.listen(0, "127.0.0.1").unref();

const loopbackUrl = (entry: Entry) =>
	// Named like the original so readers still see the file extension
	`http://127.0.0.1:${port}/${secret}/${entry.id}/${path.posix.basename(new URL(entry.url).pathname)}`;

/** Points the audio url of a message to TIDAL's player at the cache. Messages that aren't audio loads pass through */
export const rewritePlayerMessage = (message: string) => {
	if (port === undefined || !/"media\.(load|preload|recover)"/.test(message)) return message;
	try {
		const parsed = JSON.parse(message);
		const entry = typeof parsed.url === "string" ? openEntry(parsed.url) : undefined;
		if (entry === undefined) return message;
		if (parsed.command === "media.preload") preloadId = entry.id;
		else currentId = entry.id;
		regate();
		fill(entry);
		return JSON.stringify({ ...parsed, url: loopbackUrl(entry) });
	} catch {
		return message;
	}
};

/** A url serving the audio at `url` (https://*.audio.tidal.com) through the cache, which supports ranges. `undefined` for other urls */
export const audioCacheUrl = (url: string) => {
	const entry = port === undefined ? undefined : openEntry(url);
	return entry && loopbackUrl(entry);
};

/** The audio urls to fetch in the background, in priority order, e.g. of the current, next and previous track */
export const audioCacheWindow = (urls: string[]) => {
	const window = urls.map(openEntry).filter((entry) => entry !== undefined);
	windowIds = window.map((entry) => entry.id);
	regate();
	window.forEach(fill);
};

/** Fetches the start of a hovered track's audio ahead of all but what is playing. The latest hover goes first, older ones after the window */
export const audioCacheHover = (url: string) => {
	const entry = openEntry(url);
	if (entry === undefined) return;
	hoverIds = [entry.id, ...hoverIds.filter((id) => id !== entry.id)].slice(0, 4);
	regate();
	fill(entry);
};

export type AudioCacheStatus = { size?: number; held: number; complete: boolean };
export const audioCacheStatus = (url: string): AudioCacheStatus => {
	const id = idOf(url);
	const entry = id === undefined ? undefined : entries.get(id);
	const onDisk = id === undefined ? undefined : disk.get(id);
	if (entry === undefined) return { size: onDisk?.size, held: onDisk?.size ?? 0, complete: onDisk !== undefined };
	return { size: entry.size, held: heldBytes(entry.have), complete: entry.complete };
};

export type AudioCacheStats = {
	path: string;
	usage: number;
	limit: number;
	userLimit?: number;
	files: number;
	servedBytes: number;
	fetchedBytes: number;
	fetching: { id: string; priority: number; held: number; size?: number }[];
};
export const audioCacheStats = async (): Promise<AudioCacheStats> => ({
	path: dir,
	usage,
	limit: await limit(),
	userLimit,
	files: disk.size,
	...stats,
	fetching: [...active].map((entry) => ({ id: entry.id, priority: priorityOf(entry), held: heldBytes(entry.have), size: entry.size })),
});

/** Bytes the cache may use, `undefined` for the default of 128GB. It never uses more than 75% of free disk space */
export const audioCacheSetLimit = (bytes?: number) => {
	userLimit = bytes;
	return prune();
};

export const audioCacheOpenFolder = () => electron.shell.openPath(dir);
