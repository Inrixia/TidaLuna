// POC offline cache for the page's requests (stale-if-error). Every GET the page makes goes through the injector's https / luna-module handlers,
// which fetch it here: a good response is kept on disk, and when the network fails the last kept one is served instead.
// So TIDAL never sees itself offline (its api.tidal.com/v1/ping is replayed too) and needs no hooks into its render code.
// The folder is a DiskCache (cache/DiskCache.ts): kept under its limit (1GB by default), least recently / frequently used responses go first.
import { createHash } from "crypto";

import { DiskCache } from "./cache/DiskCache";
import { tidalMainHosts, tidalRequestKey } from "./tidalHosts";

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

/** The kept responses: an entry's body is the response body, its sidecar the `Meta`. 32MB of the small, often replayed ones are held in memory */
const disk = new DiskCache<Meta>({ name: "offline", defaultLimit: 1024 ** 3, memoryBytes: 32 * 1024 ** 2 });

/** Reads a copy of the response body to its end and writes it, unless the kept copy already has the same body */
const keep = async (id: string, meta: Meta, body: ReadableStream<Uint8Array>) => {
	const chunks: Uint8Array[] = [];
	const hash = createHash("sha256");
	for await (const chunk of body) {
		chunks.push(chunk);
		hash.update(chunk);
	}
	meta.sha256 = hash.digest("hex");
	const kept = disk.meta(id);
	// Unchanged: only counts as used, nothing to write
	if (kept?.sha256 === meta.sha256 && disk.touch(id)) return;
	await disk.write(id, meta, chunks);
	// A new entry counts as read once, a changed one was read by the page that loaded it too
	if (kept !== undefined) disk.touch(id);
};

const replay = async (id: string, req?: Request): Promise<Response | undefined> => {
	const entry = await disk.read(id);
	if (entry === undefined) return;
	const { meta } = entry;
	let body = <Buffer<ArrayBuffer>>entry.body;
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
	const id = createHash("sha256").update(key).digest("hex").slice(0, 40);
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
		const kept = await replay(id, req);
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
	keep(id, { url, status: res.status, statusText: res.statusText, headers }, toDisk).catch((err) => {
		if (!req?.signal.aborted) console.error(`[Luna.native] [OfflineCache] Failed to keep ${url}`, err);
	});
	return new Response(toPage, { status: res.status, statusText: res.statusText, headers });
};
