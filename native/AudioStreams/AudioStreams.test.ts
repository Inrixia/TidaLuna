import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import { Cache, CacheStore, MapBackend, StreamBufferBackend } from "../../cache";
import { net } from "../../test/harness/electron";
import { FsBackend } from "../cache/FsBackend";
import { AudioStreams, type AudioMeta, type AudioStreamsCache } from "./AudioStreams";
import { parseRange } from "./AudioStreams.http";
import { audioIdOf, expiryOf } from "./AudioStreams.urls";

let cacheSeq = 0;
let scratch: string;
let cacheDir: string;
let cache: AudioStreamsCache;
let streams: AudioStreams;

const makeStreams = async (dir: string) => {
	const createdCache: AudioStreamsCache = Cache.from(`audio-test-${++cacheSeq}`, () => ({
		memory: new CacheStore({ meta: new MapBackend(), data: new StreamBufferBackend() }),
		persist: new CacheStore({ meta: new MapBackend(), data: new FsBackend<AudioMeta>(dir) }),
	}));
	const created = new AudioStreams(createdCache);
	await created.listening;
	await createdCache.ready;
	return { cache: createdCache, streams: created };
};

/** A url as TIDAL hands it to the player: the token in the query changes every time */
const audioUrl = (track: string, token = "1700000000~signature") => `https://sp-pr-f.audio.tidal.com/mediatracks/${track}?token=${token}`;

/** Splits a loopback url `http://127.0.0.1:<port>/<mode>/<id>/<name>` into observable parts */
const loopback = (url: string) => {
	const { port, pathname } = new URL(url);
	const [, mode, id, name] = pathname.split("/");
	return { port: Number(port), mode, id, name };
};

const toWebStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
	new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});

const until = async (check: () => boolean | Promise<boolean>, what: string) => {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(`Timed out waiting for ${what}`);
};

const settle = () => until(() => (cache.stats().extra?.activeFetches ?? 0) === 0, "active fetches to finish");

type Served = { url: string; range: string; signal?: AbortSignal };
const fetchMock = net.fetch as unknown as {
	mockImplementation: (impl: (url: string, init: { headers: { Range: string }; signal?: AbortSignal }) => Promise<unknown>) => void;
};

/** TIDAL's CDN answering a ranged request */
const rangeResponse = (all: Uint8Array, range: string, type = "audio/flac") => {
	const [, startText, endText] = /^bytes=(\d+)-(\d*)$/.exec(range)!;
	const start = Number(startText);
	const end = endText === "" ? all.byteLength - 1 : Math.min(Number(endText), all.byteLength - 1);
	return {
		status: 206,
		headers: new Headers({ "content-range": `bytes ${start}-${end}/${all.byteLength}`, "content-type": type }),
		body: (async function* () {
			yield all.subarray(start, end + 1);
		})(),
	};
};

const serveAudio = (all: Uint8Array, hook?: (request: Served) => Promise<unknown> | undefined) => {
	const served: Served[] = [];
	fetchMock.mockImplementation(async (url, init) => {
		const request: Served = { url, range: init.headers.Range, signal: init.signal };
		served.push(request);
		return (await hook?.(request)) ?? rangeResponse(all, request.range);
	});
	return served;
};

/** Performs an HTTP request against the loopback server */
const httpGet = (url: string, options: { method?: string; headers?: http.OutgoingHttpHeaders } = {}) =>
	new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
		const req = http.request(url, { method: options.method ?? "GET", headers: options.headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
			res.on("error", reject);
		});
		req.on("error", reject);
		req.end();
	});

beforeAllSetup: {
	scratch = await mkdtemp(path.join(os.tmpdir(), "luna-audio-streams-test-"));
}

beforeEach(async () => {
	cacheDir = path.join(scratch, `dir-${cacheSeq + 1}`);
	serveAudio(new Uint8Array(8));
	({ cache, streams } = await makeStreams(cacheDir));
});

afterEach(async () => {
	await streams.close();
});

afterAll(async () => {
	await rm(scratch, { recursive: true, force: true });
});

describe("AudioStreams.urls & AudioStreams.http", () => {
	test("audioIdOf keys by path, normalizes host case, and rejects non-TIDAL urls", () => {
		const one = audioUrl("urls/640_16.flac", "1700000000~one");
		const two = audioUrl("urls/640_16.flac", "1800000000~two");
		const eu = "https://eu.audio.tidal.com/mediatracks/urls/640_16.flac?token=1900000000~three";
		const upper = "https://SP-PR-F.AUDIO.TIDAL.COM/mediatracks/urls/640_16.flac?token=1~x";

		expect(audioIdOf(one)).toMatch(/^[0-9a-f]{32}$/);
		expect(audioIdOf(two)).toBe(audioIdOf(one));
		expect(audioIdOf(eu)).toBe(audioIdOf(one));
		expect(audioIdOf(upper)).toBe(audioIdOf(one));
		expect(audioIdOf(audioUrl("urls/other.flac"))).not.toBe(audioIdOf(one));

		for (const invalid of [
			"https://example.com/mediatracks/640_16.flac",
			"http://sp-pr-f.audio.tidal.com/mediatracks/640_16.flac",
			"https://audio.tidal.com/mediatracks/640_16.flac",
			"https://sp-pr-f.audio.tidal.com.evil.example/mediatracks/640_16.flac",
			"https://a.b.audio.tidal.com/mediatracks/640_16.flac",
			"ftp://sp-pr-f.audio.tidal.com/mediatracks/640_16.flac",
			"nonsense",
			"",
		]) {
			expect(audioIdOf(invalid)).toBeUndefined();
			expect(streams.url(invalid)).toBeUndefined();
		}
	});

	test("expiryOf parses epoch seconds from token query or falls back to 0", () => {
		expect(expiryOf(audioUrl("exp/640_16.flac", "1750000123~sig"))).toBe(1750000123);
		expect(expiryOf("https://sp-pr-f.audio.tidal.com/mediatracks/exp/640_16.flac")).toBe(0);
	});

	test("parseRange handles open, suffix, bounded and invalid ranges", () => {
		expect(parseRange("bytes=0-3", 10)).toEqual([0, 3]);
		expect(parseRange("bytes=4-", 10)).toEqual([4, 9]);
		expect(parseRange("bytes=-3", 10)).toEqual([7, 9]);
		expect(parseRange("bytes=0-99", 10)).toEqual([0, 9]);
		expect(parseRange("bytes=20-30", 10)).toBeUndefined();
		expect(parseRange("items=0-3", 10)).toBeUndefined();
		expect(parseRange(undefined, 10)).toBeUndefined();
	});
});

describe("url & status", () => {
	test("maps an uncached TIDAL audio url to /live/<id>/<name> without claiming bytes yet", () => {
		const url = audioUrl("url/640_16.flac");
		const mapped = streams.url(url)!;
		expect(streams.url(url)).toBe(mapped);

		const parts = loopback(mapped);
		expect(parts.port).toBeGreaterThan(0);
		expect(parts.mode).toBe("live");
		expect(parts.id).toBe(audioIdOf(url));
		expect(parts.name).toBe("640_16.flac");

		expect(streams.status(url)).toEqual({ size: undefined, cachedBytes: 0, complete: false });
		expect(streams.status("https://example.com/nope.flac")).toEqual({ cachedBytes: 0, complete: false });
	});

	test("keeps the fresher token when an older token url is seen later", async () => {
		const fresh = audioUrl("token/640_16.flac", "1900000000~fresh");
		const stale = audioUrl("token/640_16.flac", "1700000000~stale");
		const served = serveAudio(Buffer.from("01234567"));

		streams.url(fresh);
		streams.window([stale]);
		await until(() => streams.status(fresh).complete, "window track to fill");

		expect(served[0].url).toBe(fresh);
	});
});

describe("rewritePlayerMessage", () => {
	test.each([
		["no media command", JSON.stringify({ command: "media.play", url: audioUrl("rw/pass/640_16.flac") })],
		["unquoted media.load", "media.load"],
		["malformed json", '{"command":"media.load",'],
		["missing url", '{"command":"media.load"}'],
		["non-string url", '{"command":"media.load","url":42}'],
		["non-TIDAL url", JSON.stringify({ command: "media.load", url: "https://example.com/640_16.flac" })],
		["plain http audio url", JSON.stringify({ command: "media.preload", url: "http://sp-pr-f.audio.tidal.com/mediatracks/640_16.flac" })],
	])("leaves %s untouched", (_name, message) => {
		expect(streams.rewritePlayerMessage(message)).toBe(message);
	});

	test("rewrites media.load, media.preload and media.recover for uncached tracks to /live and preserves encryptionKey", () => {
		const url = audioUrl("rw/live/640_16.flac");
		const raw = JSON.stringify({ command: "media.load", url, encryptionKey: "CENC-KEY", playbackSessionId: "s1" });
		const rewritten = streams.rewritePlayerMessage(raw);
		const parsed = JSON.parse(rewritten);

		expect(parsed.command).toBe("media.load");
		expect(parsed.playbackSessionId).toBe("s1");
		expect(parsed.encryptionKey).toBe("CENC-KEY");
		expect(loopback(parsed.url)).toMatchObject({ mode: "live", id: audioIdOf(url), name: "640_16.flac" });

		// Idempotent once rewritten
		expect(streams.rewritePlayerMessage(rewritten)).toBe(rewritten);

		for (const command of ["media.preload", "media.recover"]) {
			const cmdUrl = audioUrl(`rw/${command}/640_16.flac`);
			const out = JSON.parse(streams.rewritePlayerMessage(JSON.stringify({ command, url: cmdUrl, encryptionKey: "CENC-KEY" })));
			expect(loopback(out.url).mode).toBe("live");
			expect(out.encryptionKey).toBe("CENC-KEY");
		}
	});
});

describe("window, hover & HTTP serving", () => {
	test("fills a window track across gaps and serves full, ranged, HEAD and 416 responses from /live", async () => {
		const bytes = Buffer.from("0123456789abcdef");
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const served = serveAudio(bytes, (req) => {
			if (served.length > 1) return undefined;
			return Promise.resolve({
				status: 206,
				headers: new Headers({ "content-range": `bytes 0-3/${bytes.length}`, "content-type": "audio/flac" }),
				body: (async function* () {
					yield bytes.subarray(0, 4);
					await held;
				})(),
			});
		});

		const url = audioUrl("window/gap/640_16.flac");
		streams.window([url, "https://example.com/ignored.flac"]);
		await until(() => streams.status(url).cachedBytes > 0, "first chunk");
		expect(streams.status(url)).toEqual({ size: bytes.length, cachedBytes: 4, complete: false });

		release();
		await until(() => streams.status(url).complete, "remaining gap");
		expect(streams.status(url)).toEqual({ size: bytes.length, cachedBytes: bytes.length, complete: true });
		expect(served.map((s) => s.range)).toEqual(["bytes=0-", "bytes=4-15"]);

		const liveUrl = streams.url(url)!;
		const full = await httpGet(liveUrl);
		expect(full.status).toBe(200);
		expect(full.headers["content-type"]).toBe("audio/flac");
		expect(full.headers["x-luna-decrypted"]).toBeUndefined();
		expect(full.body).toEqual(bytes);

		const slice = await httpGet(liveUrl, { headers: { Range: "bytes=2-5" } });
		expect(slice.status).toBe(206);
		expect(slice.headers["content-range"]).toBe("bytes 2-5/16");
		expect(slice.body.toString()).toBe("2345");

		const head = await httpGet(liveUrl, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.body.length).toBe(0);

		const badRange = await httpGet(liveUrl, { headers: { Range: "bytes=50-60" } });
		expect(badRange.status).toBe(416);

		const missing = await httpGet(`http://127.0.0.1:${loopback(liveUrl).port}/live/unknown/file.flac`);
		expect(missing.status).toBe(404);

		expect(cache.stats().extra?.fetchedBytes).toBe(bytes.length);
		expect(cache.stats().extra?.servedBytes).toBe(bytes.length + 4);
	});

	test("hover fetches only the 2 MiB head", async () => {
		const size = 4 * 1024 ** 2; // 4 MiB
		const served = serveAudio(Buffer.alloc(size, 3));
		const url = audioUrl("hover/640_16.flac");

		streams.hover(url);
		streams.hover("https://example.com/ignored.flac");
		await until(() => streams.status(url).cachedBytes === 2 * 1024 ** 2, "2 MiB hover head");
		await settle();

		expect(streams.status(url)).toEqual({ size, cachedBytes: 2 * 1024 ** 2, complete: false });
		expect(served.map((s) => ({ url: s.url, range: s.range }))).toEqual([{ url, range: `bytes=0-${2 * 1024 ** 2 - 1}` }]);
	});

	test("out-of-order HTTP seek on /live starts a range fetch at the seek offset", async () => {
		const bytes = Buffer.from("abcdefghijklmnopqrstuvwxyz");
		const served = serveAudio(bytes);
		const url = audioUrl("seek/640_16.flac");
		const liveUrl = streams.url(url)!;

		const res = await httpGet(liveUrl, { headers: { Range: "bytes=10-15" } });
		expect(res.status).toBe(206);
		expect(res.body.toString()).toBe("klmnop");
		expect(served[0].range).toBe("bytes=10-");
	});
});

describe("waitFilled, store & tiered Cache parity", () => {
	test("stores decrypted/tagged bytes identically in memory and disk, serves /cache with X-Luna-Decrypted, and frees live buffer", async () => {
		const rawBytes = Buffer.from("encrypted-cdn-bytes");
		const taggedBytes = Buffer.from("fLaC-decrypted-and-tagged-bytes");
		serveAudio(rawBytes);

		const url = audioUrl("store/track/640_16.flac");
		expect(await streams.waitFilled(audioUrl("store/unwanted/640_16.flac"))).toBe(false);
		expect(await streams.waitFilled("https://example.com/invalid.flac")).toBe(false);

		streams.window([url]);
		expect(await streams.waitFilled(url)).toBe(true);
		expect(cache.stats().extra?.liveStreams).toBe(1);

		await streams.store(url, toWebStream(taggedBytes), {
			path: "Artist: Name/Album/Title [42].flac",
			type: "audio/flac",
		});

		// Window dropped -> live buffer is freed because track is now in `cache`
		streams.window([]);
		expect(cache.stats().extra?.liveStreams).toBe(0);
		expect(cache.stats().extra?.liveBytes).toBe(0);

		const id = audioIdOf(url)!;
		expect(cache.has(id)).toBe(true);
		expect(cache.memoryStore.has(id)).toBe(true);
		expect(cache.persistStore.has(id)).toBe(true);

		// Parity check: memory tier, persist tier on disk, and HTTP `/cache` all hold the exact same bytes and meta
		expect(cache.memoryStore.meta(id)).toMatchObject({
			path: "Artist Name/Album/Title [42].flac",
			type: "audio/flac",
			bytes: taggedBytes.length,
		});
		expect(cache.persistStore.meta(id)).toMatchObject({
			path: "Artist Name/Album/Title [42].flac",
			type: "audio/flac",
			bytes: taggedBytes.length,
		});

		const diskFile = path.join(cacheDir, "Artist Name", "Album", "Title [42].flac");
		expect(await readFile(diskFile)).toEqual(taggedBytes);

		const cacheUrl = streams.url(url)!;
		expect(loopback(cacheUrl).mode).toBe("cache");

		const served = await httpGet(cacheUrl);
		expect(served.status).toBe(200);
		expect(served.headers["x-luna-decrypted"]).toBe("1");
		expect(served.headers["content-type"]).toBe("audio/flac");
		expect(served.body).toEqual(taggedBytes);

		const head = await httpGet(cacheUrl, { method: "HEAD" });
		expect(head.status).toBe(200);

		// Subsequent player loads point at `/cache` and clear `encryptionKey`
		const load = JSON.parse(streams.rewritePlayerMessage(JSON.stringify({ command: "media.load", url, encryptionKey: "SECRET" })));
		expect(loopback(load.url).mode).toBe("cache");
		expect(load.encryptionKey).toBe("");

		// Already cached -> `waitFilled` returns false immediately
		expect(await streams.waitFilled(url)).toBe(false);
	});

	test("evicts stale key when CDN path rotates for the same relative file path, and deletes old file when path changes", async () => {
		const urlV1 = audioUrl("rotate/v1/640_16.flac");
		const urlV2 = audioUrl("rotate/v2/640_16.flac");

		await streams.store(urlV1, toWebStream(Buffer.from("first")), { path: "Artist/Album/Song [1].flac", type: "audio/flac" });
		expect(cache.has(audioIdOf(urlV1)!)).toBe(true);

		// Same file path under a new CDN path evicts the old key first
		await streams.store(urlV2, toWebStream(Buffer.from("second")), { path: "Artist/Album/Song [1].flac", type: "audio/flac" });
		expect(cache.has(audioIdOf(urlV1)!)).toBe(false);
		expect(cache.has(audioIdOf(urlV2)!)).toBe(true);
		expect(cache.persistStore.size).toBe(1);

		// Updating the same key to a renamed path deletes the previous file
		await streams.store(urlV2, toWebStream(Buffer.from("renamed")), { path: "Artist/Album/Renamed [1].flac", type: "audio/flac" });
		await expect(stat(path.join(cacheDir, "Artist", "Album", "Song [1].flac"))).rejects.toThrow();
		expect(await readFile(path.join(cacheDir, "Artist", "Album", "Renamed [1].flac"))).toEqual(Buffer.from("renamed"));
	});

	test("keeps mid-playback media.recover on /live until playback moves to another track", async () => {
		const rawBytes = Buffer.from("live-encrypted");
		const taggedBytes = Buffer.from("cached-decrypted-longer");
		serveAudio(rawBytes);

		const url = audioUrl("recover/640_16.flac");
		const initialLoad = JSON.parse(streams.rewritePlayerMessage(JSON.stringify({ command: "media.load", url, encryptionKey: "KEY" })));
		expect(loopback(initialLoad.url).mode).toBe("live");
		await until(() => streams.status(url).complete, "playing track to fill");

		await streams.store(url, toWebStream(taggedBytes), { path: "Artist/Album/Recover [9].flac", type: "audio/flac" });
		expect(loopback(streams.url(url)!).mode).toBe("cache");

		// Recover during the same session stays on `/live` so byte offsets and encryption match
		const midRecover = JSON.parse(streams.rewritePlayerMessage(JSON.stringify({ command: "media.recover", url, encryptionKey: "KEY" })));
		expect(loopback(midRecover.url).mode).toBe("live");
		expect(midRecover.encryptionKey).toBe("KEY");

		// Once another track loads, recovering the first track uses `/cache`
		streams.rewritePlayerMessage(JSON.stringify({ command: "media.load", url: audioUrl("recover/other/640_16.flac") }));
		const laterRecover = JSON.parse(streams.rewritePlayerMessage(JSON.stringify({ command: "media.recover", url, encryptionKey: "KEY" })));
		expect(loopback(laterRecover.url).mode).toBe("cache");
		expect(laterRecover.encryptionKey).toBe("");
	});
});

describe("pinning, orphan cleanup & priority gating", () => {
	test("pins playing, preloaded and window entries against cache.clear()", async () => {
		const playing = audioUrl("pin/playing/640_16.flac");
		const other = audioUrl("pin/other/640_16.flac");
		await streams.store(playing, toWebStream(Buffer.from("keep-me")), { path: "A/B/Keep [1].flac", type: "audio/flac" });
		await streams.store(other, toWebStream(Buffer.from("drop-me")), { path: "A/B/Drop [2].flac", type: "audio/flac" });

		streams.rewritePlayerMessage(JSON.stringify({ command: "media.load", url: playing }));
		await cache.clear();

		expect(cache.has(audioIdOf(playing)!)).toBe(true);
		expect(cache.has(audioIdOf(other)!)).toBe(false);
	});

	test("deletes orphan files in FsBackend folder when opened", async () => {
		const orphanDir = path.join(scratch, "orphan-dir");
		await mkdir(path.join(orphanDir, "Stray"), { recursive: true });
		const strayFile = path.join(orphanDir, "Stray", "untracked.flac");
		await writeFile(strayFile, "stray");

		const opened = await makeStreams(orphanDir);
		await until(async () => {
			try {
				await stat(strayFile);
				return false;
			} catch {
				return true;
			}
		}, "stray orphan file to be deleted");
		await opened.streams.close();
	});

	test("gates concurrent fetches so higher-priority tracks go ahead of window and older hovers", async () => {
		const bytes = Buffer.from("priority-bytes");
		const pending: (() => void)[] = [];
		const served = serveAudio(bytes, (req) => new Promise((resolve) => pending.push(() => resolve(rangeResponse(bytes, req.range)))));

		const windowFirst = audioUrl("prio/win0/640_16.flac");
		const hoverEarlier = audioUrl("prio/hover0/640_16.flac");
		const hoverLatest = audioUrl("prio/hover1/640_16.flac");
		const current = audioUrl("prio/current/640_16.flac");

		streams.window([windowFirst]);
		streams.hover(hoverEarlier);
		streams.hover(hoverLatest);
		streams.rewritePlayerMessage(JSON.stringify({ command: "media.load", url: current }));

		await until(() => served.length === 4, "each escalating top entry to start its fetch");
		expect(served.map((s) => s.url)).toEqual([windowFirst, hoverEarlier, hoverLatest, current]);

		serveAudio(bytes);
		pending.splice(0).forEach((release) => release());
		await settle();
	});
});
