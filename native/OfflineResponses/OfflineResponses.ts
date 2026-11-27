// Offline responses for the page's requests (stale-if-error). Every GET the page makes goes through the injector's https / luna-module handlers,
// which fetch it here: a good response is kept in a Cache of files, and when the network fails the last kept one is served instead.
// So TIDAL never sees itself offline (its api.tidal.com/v1/ping is replayed too) and needs no hooks into its render code.
// Kept under the cache's limit (1GB by default), least recently / frequently used responses go first.
import { createHash } from "crypto";

import type { Cache, CacheStore, MapBackend, MetaBackend } from "../../cache";
import type { FsBackend } from "../cache/FsBackend";
import { tidalMainHosts, tidalRequestKey } from "../tidalHosts";
import { nativeTrace } from "../trace";
import { cacheableType, droppedHeaders, isTidalApi, isTidalHost, json, keptHeader } from "./OfflineResponses.x";

const trace = nativeTrace.withSource("[OfflineResponses]");

/** What is kept beside a response's body to replay it, in its meta. `path` is the file the body is in */
export type OfflineMeta = { headers: [string, string][]; sha256: string };
/** Kept response bodies by `[<user>:]<request key>`, the small, often replayed ones held in memory too */
export type OfflineCache = Cache<CacheStore<MetaBackend<true>, MapBackend<Uint8Array>>, CacheStore<MetaBackend<true>, FsBackend<OfflineMeta>>>;

export class OfflineResponses {
	private lastAuth: string | undefined;
	private lastUser: string | undefined;
	private isOffline = false;

	public constructor(private readonly cache: OfflineCache) {
		// Files no meta names (e.g. written just before a crash, ahead of their meta's save) are deleted
		cache.ready
			.then(() => {
				const persist = cache.persistStore;
				return Promise.all(persist.orphans.map((file) => persist.dataBackend.deleteFile(file)));
			})
			.catch(trace.warn.withContext("Failed to delete stray files"));
	}

	/** The account a request is made as: `uid` from the Bearer token (a JWT). Kept api responses are per account, `/me` urls don't name the user */
	private userOf(req?: Request): string | undefined {
		const auth = req?.headers.get("authorization") ?? undefined;
		// Every api request carries the same token until it is refreshed
		if (auth === this.lastAuth) return this.lastUser;
		this.lastAuth = auth;
		this.lastUser = undefined;
		if (!auth?.startsWith("Bearer ")) return;
		try {
			const uid = JSON.parse(Buffer.from(auth.slice(7).split(".")[1], "base64url").toString()).uid;
			return (this.lastUser = uid === undefined ? undefined : String(uid));
		} catch {}
	}

	/** Reads a copy of the response body to its end and keeps it, unless the kept copy already has the same body */
	private async keep(key: string, headers: [string, string][], body: ReadableStream<Uint8Array>) {
		const chunks: Uint8Array[] = [];
		const hash = createHash("sha256");
		for await (const chunk of body) {
			chunks.push(chunk);
			hash.update(chunk);
		}
		const sha256 = hash.digest("hex");
		// Unchanged: only counts as used, nothing to write
		if (this.cache.meta(key)?.sha256 === sha256 && this.cache.touch(key)) return;
		const bytes = Buffer.concat(chunks);
		// The file is named by a hash of the key: keys are urls, which aren't file names
		const path = createHash("sha1").update(key).digest("hex");
		await this.cache.set(key, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), { meta: { path, headers, sha256 } });
	}

	private async replay(key: string, url: URL, req?: Request): Promise<Response | undefined> {
		const meta = this.cache.meta(key);
		let body = await this.cache.read(key);
		if (meta === undefined || body === undefined) return;
		const headers = new Headers(meta.headers);
		// TIDAL takes the server time from Date (trueTime) and counts a recent one as being online
		headers.set("date", new Date().toUTCString());
		// TIDAL matches playbackinfo to the x-tidal-streamingsessionid it sent, play reporting for a replay is lost anyway
		const sessionId = req?.headers.get("x-tidal-streamingsessionid");
		if (sessionId && url.pathname.endsWith("/playbackinfo")) {
			body = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body).toString()), streamingSessionId: sessionId }));
		}
		trace.warn("Offline, replaying", url.href);
		return new Response(new Uint8Array(body), { status: 200, headers });
	}

	private setOffline(offline: boolean) {
		this.isOffline = offline;
		globalThis.luna?.sendToRender?.("__Luna.offlineStatus", offline);
	}

	/** What to answer `url` with when it couldn't be fetched, throws `err` if nothing */
	private async offline(url: URL, key: string, err: unknown, req?: Request): Promise<Response> {
		const isApi = isTidalApi(url);
		// Only TIDAL's api and app say whether it is online, one image or cdn failing is not being offline
		if (isApi || tidalMainHosts.has(url.hostname)) this.setOffline(true);
		if (url.pathname === "/v1/ping")
			return new Response("OK", { status: 200, headers: { "content-type": "text/plain", date: new Date().toUTCString() } });
		const kept = await this.replay(key, url, req);
		if (kept !== undefined) return kept;
		if (isApi || (tidalMainHosts.has(url.hostname) && url.pathname.endsWith(".js")))
			globalThis.luna?.sendToRender?.("__Luna.offlineMiss", url.href);
		// Fail fast instead of letting TIDAL's fetchWithRetry / RTK Query retry a network error 10 times (~2 min)
		if (isApi)
			return json(404, "Not Found (Offline Cache Miss)", {
				status: 404,
				userMessage: "Offline: not in cache",
				errors: [{ detail: "Offline: not in cache" }],
			});
		throw err;
	}

	/**
	 * Fetches `url` with `fetch`, keeping a good GET response. If `fetch` throws (no network) the kept response is returned instead.
	 * Keyed by url and, for TIDAL's api, the account it is made as. Request headers (e.g. Authorization) are never stored.
	 */
	public async staleIfError(url: string, fetch: () => Promise<Response>, req?: Request): Promise<Response> {
		if (req !== undefined && req.method !== "GET") return fetch();
		const parsed = new URL(url);
		// Keyed like the page's SharedRequests (render/src/SharedRequests), so both api hosts share their entries
		const path = isTidalHost(parsed) ? tidalRequestKey(parsed) : url;
		const user = isTidalApi(parsed) ? this.userOf(req) : undefined;
		const key = user === undefined ? path : `${user}:${path}`;
		let res: Response;
		try {
			res = await fetch();
		} catch (err) {
			if (req?.signal.aborted) throw err;
			return this.offline(parsed, key, err, req);
		}
		if ((this.isOffline || parsed.pathname === "/v1/ping") && (isTidalApi(parsed) || tidalMainHosts.has(parsed.hostname))) this.setOffline(false);
		if (res.status !== 200 || res.body === null || !cacheableType.test(res.headers.get("content-type") ?? "")) return res;
		const headers = [...res.headers].filter(([name]) => !droppedHeaders.has(name.toLowerCase()));
		// The page reads one branch as it arrives, the other is kept once complete
		const [toPage, toDisk] = res.body.tee();
		this.keep(
			key,
			headers.filter(([name]) => keptHeader.test(name)),
			toDisk,
		).catch((err) => {
			if (!req?.signal.aborted) trace.err.withContext("Failed to keep", url)(err);
		});
		return new Response(toPage, { status: res.status, statusText: res.statusText, headers });
	}
}
