import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { net, setUserDataDir, shell } from "../test/harness/electron";

/**
 * native/audioCache.ts is a module level singleton: importing it starts its loopback http server and keeps the entries,
 * the disk cache and its limit in module scope. So the scratch userData folder is pointed at before the import, and the
 * whole file shares one cache, the way the app does.
 */
const scratch = await mkdtemp(path.join(os.tmpdir(), "luna-audio-cache-test-"));
setUserDataDir(scratch);
const {
	audioCacheHover,
	audioCacheOpenFolder,
	audioCachePersist,
	audioCacheSetLimit,
	audioCacheStats,
	audioCacheStatus,
	audioCacheUrl,
	audioCacheWaitFilled,
	audioCacheWindow,
	rewritePlayerMessage,
} = await import("./audioCache");

/** Created by native/audioCache.ts once electron is ready */
const cacheDir = path.join(scratch, "luna-audio-cache");

/** A url as TIDAL hands it to the player: the token in the query changes every time */
const audioUrl = (track: string, token = "1700000000~signature") => `https://sp-pr-f.audio.tidal.com/mediatracks/${track}?token=${token}`;

/** A file for tests that persist a track and do not care what it is */
const trackFileFor = (name: string) => path.join(scratch, `${name}.flac`);

/** The loopback url the cache hands out, split into the parts that are observable */
const loopback = (url: string) => {
	const { port, pathname } = new URL(url);
	const [, secret, mode, id, name] = pathname.split("/");
	return { port: Number(port), secret, mode, id, name };
};

const idOf = (url: string) => loopback(audioCacheUrl(url)!).id;

const until = async (check: () => boolean | Promise<boolean>, what: string) => {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(`Timed out waiting for ${what}`);
};

/** Resolves once no entry has a fetch in flight, so the counters below are stable */
const settle = () => until(async () => (await audioCacheStats()).fetching.length === 0, "the cache to finish fetching");

type Served = { url: string; range: string };
const fetchMock = net.fetch as unknown as {
	mockImplementation: (impl: (url: string, init: { headers: { Range: string } }) => Promise<unknown>) => void;
};

/** TIDAL's CDN answering a ranged request */
const rangeResponse = (all: Uint8Array, range: string) => {
	const [, startText, endText] = /^bytes=(\d+)-(\d*)$/.exec(range)!;
	const start = Number(startText);
	const end = endText === "" ? all.byteLength - 1 : Math.min(Number(endText), all.byteLength - 1);
	return {
		status: 206,
		headers: new Headers({ "content-range": `bytes ${start}-${end}/${all.byteLength}`, "content-type": "audio/flac" }),
		body: (async function* () {
			yield all.subarray(start, end + 1);
		})(),
	};
};

/** Makes electron.net.fetch serve `all` for any range and records the requests. `hook` can answer one itself */
const serveAudio = (all: Uint8Array, hook?: (request: Served) => Promise<unknown> | undefined) => {
	const served: Served[] = [];
	fetchMock.mockImplementation(async (url, init) => {
		const request = { url, range: init.headers.Range };
		served.push(request);
		return (await hook?.(request)) ?? rangeResponse(all, request.range);
	});
	return served;
};

beforeAll(async () => {
	// Nothing real is downloaded: every fetch is answered from these bytes
	serveAudio(new Uint8Array(8));
	await until(() => audioCacheUrl(audioUrl("startup/640_16.flac")) !== undefined, "the audio cache to start listening");
	// Waits for the cache folder to be created and scanned
	await audioCachePersist("https://example.com/not-audio.flac");
});

afterAll(async () => {
	await rm(scratch, { recursive: true, force: true });
});

describe("audioCacheStats", () => {
	test("describes an empty cache before anything is fetched", async () => {
		const stats = await audioCacheStats();
		expect(stats.path).toBe(cacheDir);
		expect((await stat(stats.path)).isDirectory()).toBe(true);
		expect(stats.files).toBe(0);
		expect(stats.usage).toBe(0);
		expect(stats.fetching).toEqual([]);
		expect(stats.servedBytes).toBe(0);
		expect(stats.fetchedBytes).toBe(0);
		expect(stats.userLimit).toBeUndefined();
		expect(stats.limit).toBeGreaterThan(0);
		expect(stats.limit).toBeLessThanOrEqual(128 * 1024 ** 3);
	});
});

describe("audioCacheUrl", () => {
	test("maps a TIDAL audio url to the loopback server", () => {
		const url = audioUrl("audioCacheUrl/640_16.flac");
		const cached = audioCacheUrl(url)!;
		expect(cached).toBeTypeOf("string");
		// Asking twice gives the same url
		expect(audioCacheUrl(url)).toBe(cached);

		const parts = loopback(cached);
		expect(parts.port).toBeGreaterThan(0);
		expect(parts.secret).toMatch(/^[0-9a-f]{32}$/);
		expect(parts.id).toMatch(/^[0-9a-f]{32}$/);
		expect(parts.mode).toBe("mem");
		// Named like the original so readers still see the file extension
		expect(parts.name).toBe("640_16.flac");
	});

	test("keys entries by path, so a fresh token or another host reuses the same entry", () => {
		const url = audioUrl("audioCacheUrl/by-path/640_16.flac", "1700000000~one");
		const freshToken = audioUrl("audioCacheUrl/by-path/640_16.flac", "1800000000~two");
		const otherHost = "https://eu.audio.tidal.com/mediatracks/audioCacheUrl/by-path/640_16.flac?token=1900000000~three";

		expect(audioCacheUrl(freshToken)).toBe(audioCacheUrl(url));
		expect(audioCacheUrl(otherHost)).toBe(audioCacheUrl(url));
		expect(audioCacheUrl(audioUrl("audioCacheUrl/by-path/other.flac"))).not.toBe(audioCacheUrl(url));
	});

	test("normalizes the host case", () => {
		expect(audioCacheUrl("https://SP-PR-F.AUDIO.TIDAL.COM/mediatracks/audioCacheUrl/upper/640_16.flac?token=1~x")).toBeDefined();
	});

	test.each([
		["a non-TIDAL host", "https://example.com/mediatracks/640_16.flac"],
		["plain http", "http://sp-pr-f.audio.tidal.com/mediatracks/640_16.flac"],
		["the bare audio host", "https://audio.tidal.com/mediatracks/640_16.flac"],
		["a lookalike domain", "https://sp-pr-f.audio.tidal.com.evil.example/mediatracks/640_16.flac"],
		["a deeper subdomain", "https://a.b.audio.tidal.com/mediatracks/640_16.flac"],
		["another protocol", "ftp://sp-pr-f.audio.tidal.com/mediatracks/640_16.flac"],
		["not a url", "nonsense"],
		["an empty string", ""],
	])("returns undefined for %s", (_name, url) => {
		expect(audioCacheUrl(url)).toBeUndefined();
	});
});

describe("audioCacheStatus", () => {
	test("nothing is known about a url that was never cached", () => {
		expect(audioCacheStatus(audioUrl("status/unknown/640_16.flac"))).toEqual({ size: undefined, held: 0, complete: false });
		expect(audioCacheStatus("https://example.com/status/unknown/640_16.flac")).toEqual({ size: undefined, held: 0, complete: false });
	});

	test("opening a url does not claim any bytes yet", () => {
		const url = audioUrl("status/opened/640_16.flac");
		expect(audioCacheUrl(url)).toBeDefined();
		expect(audioCacheStatus(url)).toEqual({ size: undefined, held: 0, complete: false });
	});
});

describe("rewritePlayerMessage", () => {
	test.each([
		["a message with no media command", JSON.stringify({ command: "media.play", url: audioUrl("rewrite/pass-through/640_16.flac") })],
		["a media command without quotes around it", "media.load"],
		["json that mentions media.load but does not parse", '{"command":"media.load",'],
		["a message without a url", '{"command":"media.load"}'],
		["a url that is not a string", '{"command":"media.load","url":42}'],
		["a json string instead of an object", '"media.load"'],
		["a url that is not TIDAL audio", JSON.stringify({ command: "media.load", url: "https://example.com/640_16.flac" })],
		["a plain http audio url", JSON.stringify({ command: "media.preload", url: "http://sp-pr-f.audio.tidal.com/mediatracks/640_16.flac" })],
	])("leaves %s alone", (_name, message) => {
		expect(rewritePlayerMessage(message)).toBe(message);
	});

	test("points media.load at the loopback server and keeps the rest of the message", () => {
		const url = audioUrl("rewrite/load/640_16.flac");
		const message = JSON.stringify({ command: "media.load", url, encryptionKey: "CENC-KEY", playbackSessionId: "session-1", bitDepth: 16 });

		const rewritten = rewritePlayerMessage(message);
		expect(rewritten).not.toBe(message);
		const parsed = JSON.parse(rewritten);
		expect(parsed.command).toBe("media.load");
		expect(parsed.playbackSessionId).toBe("session-1");
		expect(parsed.bitDepth).toBe(16);
		expect(parsed.url).not.toBe(url);

		const parts = loopback(parsed.url);
		expect(parts.mode).toBe("mem");
		expect(parts.name).toBe("640_16.flac");
		// The memory url serves the CDN's encrypted bytes, so the player still needs its key
		expect(parsed.encryptionKey).toBe("CENC-KEY");

		// Same entry, same server as the url other main process code reads through
		const readThrough = loopback(audioCacheUrl(url)!);
		expect(parts.port).toBe(readThrough.port);
		expect(parts.secret).toBe(readThrough.secret);
		expect(parts.id).toBe(readThrough.id);
	});

	test.each(["media.preload", "media.recover"])("rewrites %s to the memory url", (command) => {
		const url = audioUrl(`rewrite/${command}/640_16.flac`);
		const parsed = JSON.parse(rewritePlayerMessage(JSON.stringify({ command, url, encryptionKey: "CENC-KEY" })));
		expect(parsed.command).toBe(command);
		expect(loopback(parsed.url).mode).toBe("mem");
		expect(parsed.encryptionKey).toBe("CENC-KEY");
	});

	test("leaves an already rewritten message alone", () => {
		const once = rewritePlayerMessage(JSON.stringify({ command: "media.load", url: audioUrl("rewrite/idempotent/640_16.flac") }));
		expect(loopback(JSON.parse(once).url).mode).toBe("mem");
		expect(rewritePlayerMessage(once)).toBe(once);
	});

	test("rewrites any message whose json mentions media.load, whatever its command", () => {
		// The regex is only a cheap pre-filter; the parsed command is not validated
		const message = JSON.stringify({ type: "media.load", url: audioUrl("rewrite/quirk/640_16.flac") });
		const parsed = JSON.parse(rewritePlayerMessage(message));
		expect(parsed.type).toBe("media.load");
		expect(loopback(parsed.url).mode).toBe("mem");
	});
});

describe("audioCacheWindow", () => {
	test("fills a wanted track in memory and counts its bytes", async () => {
		await settle();
		const bytes = Buffer.from("fLaC-0123456789");
		const served = serveAudio(bytes);
		const url = audioUrl("window/full/640_16.flac");
		const fetchedBefore = (await audioCacheStats()).fetchedBytes;

		audioCacheWindow([url]);
		await until(() => audioCacheStatus(url).complete, "the track to fill");

		expect(audioCacheStatus(url)).toEqual({ size: bytes.length, held: bytes.length, complete: true });
		expect((await audioCacheStats()).fetchedBytes - fetchedBefore).toBe(bytes.length);
		// One ranged fetch for the whole (single range) file
		expect(served).toEqual([{ url, range: "bytes=0-" }]);
	});

	test("ignores urls that are not TIDAL audio", async () => {
		await settle();
		audioCacheWindow(["https://example.com/640_16.flac", "nonsense"]);
		expect((await audioCacheStats()).fetching).toEqual([]);
	});

	test("reports the bytes it holds while the rest is still arriving", async () => {
		await settle();
		const bytes = Buffer.from("0123456789");
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const served = serveAudio(bytes, (request) => {
			// First request: answer the head only and hold the body open until the test releases it
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
		const url = audioUrl("window/partial/640_16.flac");

		audioCacheWindow([url]);
		await until(() => audioCacheStatus(url).held > 0, "the first bytes");
		expect(audioCacheStatus(url)).toEqual({ size: bytes.length, held: 4, complete: false });

		release();
		await until(() => audioCacheStatus(url).complete, "the rest of the track");
		expect(audioCacheStatus(url)).toEqual({ size: bytes.length, held: bytes.length, complete: true });
		// The gap left by the first request is what it asks for next
		expect(served).toEqual([
			{ url, range: "bytes=0-" },
			{ url, range: "bytes=4-9" },
		]);
	});
});

describe("audioCacheHover", () => {
	test("fetches only the start of a hovered track", async () => {
		await settle();
		const size = 5 * 1024 ** 2;
		const bytes = Buffer.alloc(size, 7);
		const served = serveAudio(bytes);
		const url = audioUrl("hover/640_16.flac");

		audioCacheHover(url);
		await until(() => audioCacheStatus(url).held > 0, "the hovered head");

		// 2MiB ahead, what the player reads first
		expect(audioCacheStatus(url)).toEqual({ size, held: 2 * 1024 ** 2, complete: false });
		expect(served).toEqual([{ url, range: `bytes=0-${2 * 1024 ** 2 - 1}` }]);
	});

	test("ignores a url that is not TIDAL audio", () => {
		expect(audioCacheHover("https://example.com/640_16.flac")).toBeUndefined();
	});
});

describe("audioCacheWaitFilled", () => {
	test("resolves with the cache folder once a wanted track is in memory", async () => {
		const url = audioUrl("waitFilled/640_16.flac");
		serveAudio(Buffer.from("wait-filled-bytes"));
		audioCacheWindow([url]);

		expect(await audioCacheWaitFilled(url)).toBe(cacheDir);
		expect(audioCacheStatus(url).complete).toBe(true);
		// Nothing wrote the file, so release the entry from persisting
		await audioCachePersist(url);
	});

	test("resolves nothing for a track nothing wants", async () => {
		expect(await audioCacheWaitFilled(audioUrl("waitFilled/not-wanted/640_16.flac"))).toBeUndefined();
	});

	test("resolves nothing for a url that is not TIDAL audio", async () => {
		expect(await audioCacheWaitFilled("https://example.com/640_16.flac")).toBeUndefined();
	});
});

describe("disk cache", () => {
	const track = audioUrl("disk/persisted/640_16.flac");
	const trackFile = path.join(scratch, "persisted-track.flac");
	const trackBytes = Buffer.from("0123456789");

	beforeAll(async () => {
		await writeFile(trackFile, trackBytes);
		await audioCachePersist(track, trackFile);
	});

	test("reports a persisted track as complete and on disk", async () => {
		expect(audioCacheStatus(track)).toEqual({ size: trackBytes.length, held: trackBytes.length, complete: true });

		const sidecar = JSON.parse(await readFile(path.join(cacheDir, `${idOf(track)}.json`), "utf8"));
		expect(sidecar).toEqual({ file: "persisted-track.flac", size: trackBytes.length, type: "audio/flac" });

		const stats = await audioCacheStats();
		expect(stats.files).toBe(1);
		expect(stats.usage).toBe(trackBytes.length);
	});

	test("serves a persisted track through the disk url", () => {
		const parts = loopback(audioCacheUrl(track)!);
		expect(parts.mode).toBe("disk");
		expect(parts.id).toBe(idOf(track));
		expect(parts.name).toBe("640_16.flac");
	});

	test("rewrites player messages to the disk url and drops the encryption key", async () => {
		await settle();
		const load = JSON.parse(rewritePlayerMessage(JSON.stringify({ command: "media.load", url: track, encryptionKey: "CENC-KEY" })));
		expect(loopback(load.url).mode).toBe("disk");
		// The file on disk is decrypted, so the player gets no key
		expect(load.encryptionKey).toBe("");

		// The key is added even when the message had none
		const preload = JSON.parse(rewritePlayerMessage(JSON.stringify({ command: "media.preload", url: track })));
		expect(loopback(preload.url).mode).toBe("disk");
		expect(preload.encryptionKey).toBe("");

		// A track that is already on disk needs no fetch
		expect((await audioCacheStats()).fetching).toEqual([]);
	});
});

describe("audioCachePersist", () => {
	test("does nothing without a file", async () => {
		const url = audioUrl("persist/no-file/640_16.flac");
		await expect(audioCachePersist(url)).resolves.toBeUndefined();
		expect(audioCacheStatus(url)).toEqual({ size: undefined, held: 0, complete: false });
	});

	test("does nothing for a url that is not TIDAL audio", async () => {
		await expect(audioCachePersist("https://example.com/640_16.flac", trackFileFor("ignored"))).resolves.toBeUndefined();
		expect((await audioCacheStats()).files).toBe(1);
	});

	test("keeps the content type the cdn reported", async () => {
		await settle();
		const bytes = Buffer.from("mp3-bytes");
		serveAudio(bytes, (request) => {
			const response = rangeResponse(bytes, request.range);
			response.headers.set("content-type", "audio/mpeg");
			return Promise.resolve(response);
		});
		const url = audioUrl("persist/content-type/640_16.mp3");
		audioCacheWindow([url]);
		await until(() => audioCacheStatus(url).complete, "the mp3 to fill");

		const file = trackFileFor("content-type-track");
		await writeFile(file, bytes);
		await audioCachePersist(url, file);

		const sidecar = JSON.parse(await readFile(path.join(cacheDir, `${idOf(url)}.json`), "utf8"));
		expect(sidecar).toEqual({ file: "content-type-track.flac", size: bytes.length, type: "audio/mpeg" });
	});

	test("replaces an earlier file for the same track instead of counting both", async () => {
		const url = audioUrl("persist/replace/640_16.flac");
		const first = trackFileFor("replace-first");
		const second = trackFileFor("replace-second");
		await writeFile(first, Buffer.from("aaaa"));
		await writeFile(second, Buffer.from("bbbbbb"));

		const before = await audioCacheStats();
		await audioCachePersist(url, first);
		expect((await audioCacheStats()).usage - before.usage).toBe(4);
		await audioCachePersist(url, second);
		const replaced = await audioCacheStats();
		// The replaced file no longer counts towards usage, and the entry is not duplicated
		expect(replaced.usage - before.usage).toBe(6);
		expect(replaced.files).toBe(before.files + 1);

		const sidecar = JSON.parse(await readFile(path.join(cacheDir, `${idOf(url)}.json`), "utf8"));
		expect(sidecar).toEqual({ file: "replace-second.flac", size: 6, type: "audio/flac" });
	});
});

describe("audioCacheOpenFolder", () => {
	test("opens the cache folder", async () => {
		await expect(audioCacheOpenFolder()).resolves.toBe("");
		expect(shell.openPath).toHaveBeenCalledWith(cacheDir);
	});
});

describe("media.recover", () => {
	test("keeps the memory url of the track that is playing, and recovers to disk once it is not", async () => {
		await settle();
		const bytes = Buffer.from("recover-mid-play");
		serveAudio(bytes);
		const url = audioUrl("recover/640_16.flac");

		const load = JSON.parse(rewritePlayerMessage(JSON.stringify({ command: "media.load", url, encryptionKey: "CENC-KEY" })));
		expect(loopback(load.url).mode).toBe("mem");
		await until(() => audioCacheStatus(url).complete, "the playing track to fill");

		// The track finished filling, so it is persisted to disk while it is still playing
		const file = trackFileFor("recover-track");
		await writeFile(file, bytes);
		await audioCachePersist(url, file);
		// Reads get the decrypted file now
		expect(loopback(audioCacheUrl(url)!).mode).toBe("disk");

		const playing = JSON.parse(rewritePlayerMessage(JSON.stringify({ command: "media.recover", url, encryptionKey: "CENC-KEY" })));
		expect(loopback(playing.url).mode).toBe("mem");
		expect(playing.encryptionKey).toBe("CENC-KEY");

		// Another track starts, so this one is recovered from its file
		serveAudio(Buffer.from("other"));
		rewritePlayerMessage(JSON.stringify({ command: "media.load", url: audioUrl("recover/other/640_16.flac") }));

		const recovered = JSON.parse(rewritePlayerMessage(JSON.stringify({ command: "media.recover", url, encryptionKey: "CENC-KEY" })));
		expect(loopback(recovered.url).mode).toBe("disk");
		expect(recovered.encryptionKey).toBe("");
	});
});

describe("audioCacheSetLimit", () => {
	test("stores the limit and reports it", async () => {
		const pruning = audioCacheSetLimit(1024);
		expect(pruning).toBeInstanceOf(Promise);
		await expect(pruning).resolves.toBeUndefined();

		const stats = await audioCacheStats();
		expect(stats.userLimit).toBe(1024);
		expect(stats.limit).toBe(1024);
	});

	test("prunes the least recently used files down to the limit", async () => {
		const url = audioUrl("limit/640_16.flac");
		const file = trackFileFor("limit-track");
		await writeFile(file, Buffer.from("0123456789"));
		await audioCachePersist(url, file);
		const sidecar = path.join(cacheDir, `${idOf(url)}.json`);
		await expect(stat(sidecar)).resolves.toBeDefined();

		const before = await audioCacheStats();
		expect(before.files).toBeGreaterThan(0);
		expect(before.usage).toBeGreaterThan(0);

		await audioCacheSetLimit(1);

		expect(audioCacheStatus(url)).toEqual({ size: undefined, held: 0, complete: false });
		await expect(stat(sidecar)).rejects.toThrow();
		const after = await audioCacheStats();
		expect(after.files).toBeLessThan(before.files);
		expect(after.usage).toBeLessThan(before.usage);

		await audioCacheSetLimit(undefined);
		expect((await audioCacheStats()).userLimit).toBeUndefined();
	});
});

describe("priority order", () => {
	test("the player's track outranks hovers, preloads and the renderer's window", async () => {
		await settle();
		const bytes = Buffer.from("priority-bytes");
		const pending: (() => void)[] = [];
		// Fetches that never answer until the test releases them, so what is in flight can be inspected
		const served = serveAudio(bytes, (request) => new Promise((resolve) => pending.push(() => resolve(rangeResponse(bytes, request.range)))));
		const current = audioUrl("priority/current/640_16.flac");
		const preload = audioUrl("priority/preload/640_16.flac");
		const windowFirst = audioUrl("priority/window-0/640_16.flac");
		const windowSecond = audioUrl("priority/window-1/640_16.flac");
		const hoveredEarlier = audioUrl("priority/hover-earlier/640_16.flac");
		const hoveredLatest = audioUrl("priority/hover-latest/640_16.flac");

		audioCacheWindow([windowFirst, windowSecond]);
		audioCacheHover(hoveredEarlier);
		audioCacheHover(hoveredLatest);
		rewritePlayerMessage(JSON.stringify({ command: "media.preload", url: preload }));
		rewritePlayerMessage(JSON.stringify({ command: "media.load", url: current }));

		const stats = await audioCacheStats();
		const priority = new Map(stats.fetching.map((entry) => [entry.id, entry.priority]));
		expect(priority.get(idOf(current))).toBe(4);
		expect(priority.get(idOf(hoveredLatest))).toBe(3);
		expect(priority.get(idOf(preload))).toBe(2);
		expect(priority.get(idOf(windowFirst))).toBe(2);
		expect(priority.get(idOf(windowSecond))).toBeCloseTo(1.9, 5);
		expect(priority.get(idOf(hoveredEarlier))).toBe(1);
		expect(stats.fetching.find((entry) => entry.id === idOf(current))).toEqual({ id: idOf(current), priority: 4, held: 0, size: undefined });

		// Only the entries on top of the order are allowed to fetch, one per priority level
		await until(() => served.length > 0, "the top priority fetches to start");
		expect(served.map((request) => request.url)).toEqual([windowFirst, hoveredEarlier, hoveredLatest, current]);

		// Let everything finish so the cache is idle for any later test
		serveAudio(bytes);
		pending.splice(0).forEach((release) => release());
		await settle();
	});

	test("re-hovering a track puts it ahead of the other hovers", async () => {
		await settle();
		const bytes = Buffer.from("priority-bytes");
		const pending: (() => void)[] = [];
		serveAudio(bytes, (request) => new Promise((resolve) => pending.push(() => resolve(rangeResponse(bytes, request.range)))));
		const first = audioUrl("priority/rehover-0/640_16.flac");
		const second = audioUrl("priority/rehover-1/640_16.flac");

		audioCacheHover(first);
		audioCacheHover(second);
		audioCacheHover(first);

		const priority = new Map((await audioCacheStats()).fetching.map((entry) => [entry.id, entry.priority]));
		expect(priority.get(idOf(first))).toBe(3);
		expect(priority.get(idOf(second))).toBe(1);

		serveAudio(bytes);
		pending.splice(0).forEach((release) => release());
		await settle();
	});
});
