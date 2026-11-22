// POC offline cache for the page's requests (stale-if-error). Every GET the page makes goes through the injector's https / luna-module handlers,
// which fetch it here: a good response is kept on disk, and when the network fails the last kept one is served instead.
// So TIDAL never sees itself offline (its api.tidal.com/v1/ping is replayed too) and needs no hooks into its render code.
// shortcut: the cache is never pruned, add a size cap (LRU by mtime) before this ships.
import electron from "electron";

import { createHash } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import path from "path";

const cacheDir = () => path.join(electron.app.getPath("userData"), "luna-offline-cache");
// What the page renders from. Leaves out audio/video (audioCache.ts keeps audio) and anything streamed
const cacheableType = /json|javascript|text\/|image\/|font/;
// Headers that describe the original transfer, not the kept body
const droppedHeaders = ["set-cookie", "content-encoding", "content-length", "transfer-encoding"];

type Meta = { url: string; status: number; statusText: string; headers: [string, string][] };

const keep = async (file: string, meta: Meta, body: Buffer) => {
	await mkdir(cacheDir(), { recursive: true });
	await writeFile(file + ".part", body);
	await rename(file + ".part", file);
	await writeFile(file + ".json", JSON.stringify(meta));
};

const replay = async (file: string, req?: Request): Promise<Response | undefined> => {
	let meta: Meta, body: Buffer<ArrayBuffer>;
	try {
		[meta, body] = await Promise.all([readFile(file + ".json", "utf8").then(JSON.parse), readFile(file)]);
	} catch {
		return;
	}
	const headers = new Headers(meta.headers);
	// TIDAL takes the server time from Date (trueTime) and counts a recent one as being online
	headers.set("date", new Date().toUTCString());
	// TIDAL matches playbackinfo to the x-tidal-streamingsessionid it sent, play reporting for a replay is lost anyway
	const sessionId = req?.headers.get("x-tidal-streamingsessionid");
	if (sessionId && /\/playbackinfo$/.test(new URL(meta.url).pathname)) {
		body = Buffer.from(JSON.stringify({ ...JSON.parse(body.toString()), streamingSessionId: sessionId }));
	}
	console.warn(`[Luna.native] [OfflineCache] Offline, replaying ${meta.url}`);
	return new Response(body, { status: meta.status, statusText: meta.statusText, headers });
};

/**
 * Fetches `url` with `fetch`, keeping a good GET response on disk. If `fetch` throws (no network) the kept response is returned instead.
 * Keyed by url only, request headers (e.g. Authorization) are never stored.
 */
export const staleIfError = async (url: string, fetch: () => Promise<Response>, req?: Request): Promise<Response> => {
	if (req !== undefined && req.method !== "GET") return fetch();
	const file = path.join(cacheDir(), createHash("sha256").update(url).digest("hex").slice(0, 40));
	let res: Response;
	try {
		res = await fetch();
	} catch (err) {
		if (req?.signal.aborted) throw err;
		const kept = await replay(file, req);
		if (kept !== undefined) return kept;
		throw err;
	}
	if (res.status !== 200 || !cacheableType.test(res.headers.get("content-type") ?? "")) return res;
	const body = Buffer.from(await res.arrayBuffer());
	const headers = [...res.headers].filter(([name]) => !droppedHeaders.includes(name.toLowerCase()));
	keep(file, { url, status: res.status, statusText: res.statusText, headers }, body).catch((err) =>
		console.error(`[Luna.native] [OfflineCache] Failed to keep ${url}`, err),
	);
	return new Response(body, { status: res.status, statusText: res.statusText, headers });
};
