// POC audio cache. TIDAL's native player (TIDALPlayer.exe) fetches audio itself from a url TIDAL sends it over stdin (media.load / media.preload),
// so Luna can't see that traffic. Those messages are rewritten (rewritePlayerMessage) to point at a loopback server here, which serves the audio from the cache.
// - Tracks in the window (the current, previous and next, set by the renderer through audioCacheWindow) are downloaded whole and held in memory.
// - Every complete download is also kept on disk, where a replay is served from without touching the network.
// shortcut: the disk cache is never pruned and a seek past what has downloaded waits for the download, add a size cap (LRU) and ranged fetches before this ships.
import electron from "electron";

import { createHash } from "crypto";
import { createReadStream, readFileSync } from "fs";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import http from "http";
import path from "path";
import { pipeline } from "stream/promises";

const audioHost = /^[\w-]+\.audio\.tidal\.com$/;

type Entry = {
	id: string;
	/** Latest url seen for this audio, its token is what the CDN accepts */
	url: string;
	file: string;
	size?: number;
	type: string;
	/** The whole file, filled up to `loaded` while downloading. Only held for tracks in the window */
	data?: Buffer;
	loaded: number;
	/** All of the file is on disk */
	complete: boolean;
	download?: Promise<void>;
	abort?: AbortController;
	error?: Error;
	waiters: Set<() => void>;
};
const entries = new Map<string, Entry>();
let windowIds = new Set<string>();
// The player's last two loads, it may be reading them
let playerIds: string[] = [];

const cacheDir = () => path.join(electron.app.getPath("userData"), "luna-audio-cache");

// Keyed by path, the token in the query changes
const openEntry = (rawUrl: string): Entry | undefined => {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return;
	}
	if (url.protocol !== "https:" || !audioHost.test(url.hostname)) return;

	const id = createHash("sha1").update(url.pathname).digest("hex").slice(0, 32);
	let entry = entries.get(id);
	if (entry === undefined) {
		const file = path.join(cacheDir(), id);
		entry = { id, url: rawUrl, file, type: "application/octet-stream", loaded: 0, complete: false, waiters: new Set() };
		try {
			const meta = JSON.parse(readFileSync(file + ".json", "utf8"));
			Object.assign(entry, { size: meta.size, type: meta.type, loaded: meta.size, complete: true });
		} catch {
			// Not on disk
		}
		entries.set(id, entry);
	}
	entry.url = rawUrl;
	return entry;
};

const wake = (entry: Entry) => {
	for (const waiter of entry.waiters) waiter();
	entry.waiters.clear();
};
const until = (entry: Entry, condition: () => boolean) =>
	new Promise<void>((resolve) => {
		const check = () => (condition() ? resolve() : entry.waiters.add(check));
		check();
	});

const startDownload = (entry: Entry) => {
	if (entry.download !== undefined) return entry.download;
	entry.error = undefined;
	const abort = (entry.abort = new AbortController());
	const download = (async () => {
		const res = await electron.net.fetch(entry.url, { signal: abort.signal, bypassCustomProtocolHandlers: true });
		const size = Number(res.headers.get("content-length"));
		if (!res.ok || res.body === null || !(size > 0)) throw new Error(`Audio download failed, HTTP ${res.status}`);
		const data = (entry.data = Buffer.allocUnsafe(size));
		entry.size = size;
		entry.type = res.headers.get("content-type") ?? entry.type;
		entry.loaded = 0;
		wake(entry);
		for await (const chunk of res.body) {
			// Buffer.from(chunk.buffer, ..) would be a view of whatever the chunk was cut from
			data.set(chunk, entry.loaded);
			entry.loaded += chunk.byteLength;
			wake(entry);
		}
		if (entry.loaded !== size) throw new Error(`Audio download ended at ${entry.loaded} of ${size} bytes`);
		await mkdir(cacheDir(), { recursive: true });
		await writeFile(entry.file + ".part", data);
		await rename(entry.file + ".part", entry.file);
		await writeFile(entry.file + ".json", JSON.stringify({ size, type: entry.type }));
		entry.complete = true;
		// Dropped from memory when it isn't one to keep, nothing needs to read it from there now
		if (!isKept(entry)) entry.data = undefined;
	})()
		.catch((err) => {
			entry.error = err;
			entry.data = undefined;
			entry.size = undefined;
			entry.loaded = 0;
			if (!abort.signal.aborted) console.error(`[Luna.native] [AudioCache] ${entry.id}`, err);
		})
		.finally(() => {
			entry.download = undefined;
			wake(entry);
		});
	return (entry.download = download);
};

const isKept = (entry: Entry) => windowIds.has(entry.id) || playerIds.includes(entry.id);

/** Starts what a kept entry needs to be served from memory */
const warm = (entry: Entry) => {
	if (!entry.complete) startDownload(entry);
	else if (entry.data === undefined) {
		readFile(entry.file).then(
			(data) => (entry.data ??= isKept(entry) ? data : undefined),
			() => undefined,
		);
	}
};

/** Anything not kept stops downloading or is let go of from memory, complete files stay on disk */
const prune = () => {
	for (const entry of entries.values()) {
		if (isKept(entry)) continue;
		if (entry.download !== undefined) entry.abort?.abort();
		else if (entry.complete) entry.data = undefined;
	}
};

/** The audio urls to hold in memory, e.g. of the previous, current and next track. Everything else is let go of from memory */
export const audioCacheWindow = (urls: string[]) => {
	const window = urls.map(openEntry).filter((entry) => entry !== undefined);
	windowIds = new Set(window.map((entry) => entry.id));
	prune();
	window.forEach(warm);
};

const parseRange = (header: string | undefined, size: number): [start: number, end: number] | undefined => {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
	if (match === null) return;
	let start = match[1] === "" ? size - Number(match[2]) : Number(match[1]);
	const end = match[1] === "" || match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
	start = Math.max(0, start);
	if (start > end) return;
	return [start, end];
};

const serve = async (req: http.IncomingMessage, res: http.ServerResponse) => {
	const entry = entries.get(req.url?.split("/")[1] ?? "");
	if (entry === undefined) return void res.writeHead(404).end();

	if (!entry.complete) startDownload(entry);
	await until(entry, () => entry.complete || entry.data !== undefined || entry.error !== undefined);
	const size = entry.size;
	if (size === undefined || (!entry.complete && entry.data === undefined)) return void res.writeHead(502).end();

	const rangeHeader = req.headers.range;
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

	const data = entry.data;
	if (data === undefined) {
		// Complete and not in memory, so on disk
		await pipeline(createReadStream(entry.file, { start, end }), res);
		return;
	}
	for (let pos = start; pos <= end && !res.destroyed;) {
		const available = Math.min(entry.complete ? size : entry.loaded, end + 1);
		if (available <= pos) {
			await until(entry, () => entry.complete || entry.loaded > pos || entry.error !== undefined);
			if (entry.error !== undefined) return void res.destroy(entry.error);
			continue;
		}
		if (!res.write(data.subarray(pos, available))) await new Promise((resolve) => res.once("drain", resolve));
		pos = available;
	}
	res.end();
};

let port: number | undefined;
const server = http.createServer((req, res) => {
	serve(req, res).catch((err) => res.destroy(err));
});
server.on("listening", () => (port = (<{ port: number }>server.address()).port));
server.on("error", (err) => console.error("[Luna.native] [AudioCache] server error, playing from TIDAL's urls", err));
server.listen(0, "127.0.0.1").unref();

/** Points the audio url of a message to TIDAL's player at the cache. Messages that aren't audio loads pass through */
export const rewritePlayerMessage = (message: string) => {
	if (port === undefined || !/"media\.(load|preload|recover)"/.test(message)) return message;
	try {
		const parsed = JSON.parse(message);
		const entry = typeof parsed.url === "string" ? openEntry(parsed.url) : undefined;
		if (entry === undefined) return message;
		playerIds = [entry.id, ...playerIds].slice(0, 2);
		prune();
		warm(entry);
		// Named like the original so the player still sees the file extension
		return JSON.stringify({ ...parsed, url: `http://127.0.0.1:${port}/${entry.id}/${path.posix.basename(new URL(entry.url).pathname)}` });
	} catch {
		return message;
	}
};
