// POC offline cache for the page's requests (stale-if-error). Every GET the page makes goes through the injector's https / luna-module handlers,
// which fetch it here: a good response is kept on disk, and when the network fails the last kept one is served instead.
// So TIDAL never sees itself offline (its api.tidal.com/v1/ping is replayed too) and needs no hooks into its render code.
// The folder is kept under its limit (1GB by default), least recently used responses (by mtime, a replay touches its file) go first.
import electron from "electron";

import { createHash } from "crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "fs/promises";
import path from "path";

import { tidalMainHosts, tidalRequestKey } from "./tidalHosts";

const cacheDir = () => path.join(electron.app.getPath("userData"), "luna-offline-cache");
// What the page renders from. Leaves out audio/video (audioCache.ts keeps audio) and anything streamed
const cacheableType = /json|javascript|text\/|image\/|font/;
// Headers that describe the original transfer, not the kept body
const droppedHeaders = ["set-cookie", "content-encoding", "content-length", "transfer-encoding"];

const isTidalHost = (url: URL) => url.hostname === "tidal.com" || url.hostname.endsWith(".tidal.com");
const isTidalApi = (url: URL) =>
	url.hostname === "api.tidal.com" || url.hostname === "openapi.tidal.com" || (tidalMainHosts.has(url.hostname) && /^\/v[12]\//.test(url.pathname));
// Keyed like requestCache.ts, so both api hosts share their entries
const keyOf = (url: URL) => (isTidalHost(url) ? tidalRequestKey(url) : url.href);
// Only TIDAL's api and app say whether it is online, one image or cdn failing is not being offline
const tellsOnline = (url: URL) => isTidalApi(url) || tidalMainHosts.has(url.hostname);
/** The account a request is made as: `uid` from the Bearer token (a JWT). Kept api responses are per account, `/me` urls don't name the user */
const userOf = (req?: Request): string | undefined => {
	const auth = req?.headers.get("authorization");
	if (!auth?.startsWith("Bearer ")) return;
	try {
		const uid = JSON.parse(Buffer.from(auth.slice(7).split(".")[1], "base64url").toString()).uid;
		return uid === undefined ? undefined : String(uid);
	} catch {
		return;
	}
};

let isOffline = false;

type Meta = { url: string; status: number; statusText: string; headers: [string, string][]; sha256?: string };

const defaultLimit = 1024 ** 3;
/** Bytes the folder may use, `undefined` for the default of 1GB */
let userLimit: number | undefined;
const limit = () => userLimit ?? defaultLimit;
/** Bytes in the folder as of the last prune plus what was written since, `undefined` until the first prune */
let usage: number | undefined;
// Bytes written since the last prune, the next one runs once they pass a 32nd of the limit
let writtenBytes = 0;
let pruning: Promise<void> | undefined;
/** Deletes the least recently used responses (body + .json) until the folder is within its limit */
const prune = (): Promise<void> =>
	(pruning ??= (async () => {
		writtenBytes = 0;
		const dir = cacheDir();
		const names = await readdir(dir).catch(() => <string[]>[]);
		const kept = new Map<string, { size: number; used: number }>();
		let bytes = 0;
		await Promise.all(
			names.map(async (name) => {
				const info = await stat(path.join(dir, name)).catch(() => undefined);
				if (info === undefined) return;
				if (name.endsWith(".part")) {
					// A write in progress is left alone, one older than an hour was cut off (crash, full disk)
					if (Date.now() - info.mtimeMs > 60 * 60_000) await rm(path.join(dir, name), { force: true });
					else bytes += info.size;
					return;
				}
				bytes += info.size;
				const key = name.replace(/\.json$/, "");
				const entry = kept.get(key) ?? { size: 0, used: 0 };
				entry.size += info.size;
				entry.used = Math.max(entry.used, info.mtimeMs);
				kept.set(key, entry);
			}),
		);
		const max = limit();
		for (const [key, { size }] of [...kept].sort(([, a], [, b]) => a.used - b.used)) {
			if (bytes <= max) break;
			await rm(path.join(dir, key + ".json"), { force: true });
			await rm(path.join(dir, key), { force: true });
			bytes -= size;
		}
		usage = bytes;
	})()
		.catch((err) => console.error("[Luna.native] [OfflineCache] Failed to prune", err))
		.finally(() => (pruning = undefined)));
electron.app.whenReady().then(() => setTimeout(prune, 30_000));

let partId = 0;
/** Reads a copy of the response body to its end and writes it, unless the kept copy already has the same body */
const keep = async (file: string, meta: Meta, body: ReadableStream<Uint8Array>) => {
	const chunks: Uint8Array[] = [];
	const hash = createHash("sha256");
	for await (const chunk of body) {
		chunks.push(chunk);
		hash.update(chunk);
	}
	meta.sha256 = hash.digest("hex");
	const kept = await readFile(file + ".json", "utf8").then(
		(json) => (<Meta>JSON.parse(json)).sha256,
		() => undefined,
	);
	// Unchanged: only marked as just seen, so the file's age stays when it was last loaded
	if (kept === meta.sha256) {
		try {
			const now = new Date();
			return await utimes(file, now, now);
		} catch {
			// The body is gone, written again below
		}
	}
	await mkdir(cacheDir(), { recursive: true });
	// Own part file per write, two loads of the same url can overlap
	const part = `${file}.${++partId}.part`;
	await writeFile(part, chunks);
	await rename(part, file);
	await writeFile(file + ".json", JSON.stringify(meta));
	// shortcut: counts a rewrite of a kept response as new bytes, the next prune recounts the folder
	const written = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	writtenBytes += written;
	if (usage !== undefined) usage += written;
	if (writtenBytes > limit() / 32) prune();
};

export type OfflineCacheStats = { path: string; usage: number; limit: number; userLimit?: number };
export const offlineCacheStats = async (): Promise<OfflineCacheStats> => {
	if (usage === undefined) await prune();
	return { path: cacheDir(), usage: usage ?? 0, limit: limit(), userLimit };
};
/** Bytes the cache may use, `undefined` for the default of 1GB */
export const offlineCacheSetLimit = (bytes?: number) => {
	userLimit = bytes;
	return prune();
};
export const offlineCacheOpenFolder = () => electron.shell.openPath(cacheDir());

const replay = async (file: string, req?: Request): Promise<Response | undefined> => {
	let meta: Meta, body: Buffer<ArrayBuffer>;
	try {
		[meta, body] = await Promise.all([readFile(file + ".json", "utf8").then(JSON.parse), readFile(file)]);
	} catch {
		return;
	}
	// Used now, so prune keeps it longer
	const now = new Date();
	utimes(file, now, now).catch(() => {});
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
 * Keyed by url and, for TIDAL's api, the account it is made as. Request headers (e.g. Authorization) are never stored.
 */
export const staleIfError = async (url: string, fetch: () => Promise<Response>, req?: Request): Promise<Response> => {
	if (req !== undefined && req.method !== "GET") return fetch();
	const parsedUrl = new URL(url);
	const user = isTidalApi(parsedUrl) ? userOf(req) : undefined;
	const key = user === undefined ? keyOf(parsedUrl) : `${user}:${keyOf(parsedUrl)}`;
	const file = path.join(cacheDir(), createHash("sha256").update(key).digest("hex").slice(0, 40));
	let res: Response;
	try {
		res = await fetch();
	} catch (err) {
		if (req?.signal.aborted) throw err;
		if (tellsOnline(parsedUrl)) {
			isOffline = true;
			globalThis.luna?.sendToRender?.("__Luna.offlineStatus", true);
		}
		if (parsedUrl.pathname === "/v1/ping") {
			return new Response("OK", { status: 200, headers: { "content-type": "text/plain", date: new Date().toUTCString() } });
		}
		const kept = await replay(file, req);
		if (kept !== undefined) return kept;
		if (isTidalApi(parsedUrl)) {
			globalThis.luna?.sendToRender?.("__Luna.offlineMiss", url);
			// Fail fast instead of letting TIDAL's fetchWithRetry / RTK Query retry a network error 10 times (~2 min)
			return new Response(
				JSON.stringify({ status: 404, userMessage: "Offline: not in cache", errors: [{ detail: "Offline: not in cache" }] }),
				{
					status: 404,
					statusText: "Not Found (Offline Cache Miss)",
					headers: {
						"content-type": "application/json",
						date: new Date().toUTCString(),
						"x-luna-offline-miss": "1",
					},
				},
			);
		}
		if (tidalMainHosts.has(parsedUrl.hostname) && parsedUrl.pathname.endsWith(".js")) {
			globalThis.luna?.sendToRender?.("__Luna.offlineMiss", url);
		}
		throw err;
	}
	if (tellsOnline(parsedUrl) && (isOffline || parsedUrl.pathname === "/v1/ping")) {
		isOffline = false;
		globalThis.luna?.sendToRender?.("__Luna.offlineStatus", false);
	}
	if (res.status !== 200 || res.body === null || !cacheableType.test(res.headers.get("content-type") ?? "")) return res;
	const headers = [...res.headers].filter(([name]) => !droppedHeaders.includes(name.toLowerCase()));
	// The page reads one branch as it arrives, the other is kept once complete
	const [toPage, toDisk] = res.body.tee();
	keep(file, { url, status: res.status, statusText: res.statusText, headers }, toDisk).catch((err) => {
		if (!req?.signal.aborted) console.error(`[Luna.native] [OfflineCache] Failed to keep ${url}`, err);
	});
	return new Response(toPage, { status: res.status, statusText: res.statusText, headers });
};
