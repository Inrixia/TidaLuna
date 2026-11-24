import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Readable } from "stream";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { fetchMediaItemStream } from "../../../../lib.native/src/index.native";

import { finalizeDashDownload, finalizeHlsDownload } from "./MediaItem.finalizeDash.native";

import { download, downloadProgress } from "./MediaItem.download.native";

import type { PlaybackInfo, VideoPlaybackInfo } from "../../helpers";
import type * as redux from "../../redux";
import type { MetaTags } from "./MediaItem.tags";

/**
 * `download` writes a TIDAL stream to the path the caller chose (sanitized, because track titles are not file names),
 * reports progress by item id while it runs, and hands DASH/HLS downloads to the remuxer once the bytes are on disk.
 * The stream fetcher and the remuxer are the neighbouring native modules, replaced here; the filesystem is real, in a
 * temporary directory.
 *
 * `luna.assertDownloadPath` (native/downloadFolders.ts) is the check that the path is where the user picked in a Luna
 * dialog. It is stubbed to allow everything, and the cases that matter for it say so.
 */
const assertDownloadPath = vi.hoisted(() => vi.fn());

vi.mock("../../../../lib.native/src/index.native", () => ({ fetchMediaItemStream: vi.fn() }));
vi.mock("./MediaItem.finalizeDash.native", () => ({ finalizeDashDownload: vi.fn(), finalizeHlsDownload: vi.fn() }));

const fetchStream = vi.mocked(fetchMediaItemStream);
const finalizeDash = vi.mocked(finalizeDashDownload);
const finalizeHls = vi.mocked(finalizeHlsDownload);

let dir: string;
/** Every test uses its own item id: the module keeps in-flight downloads by id */
let itemSeq = 900_000;
const nextId = () => ++itemSeq;

beforeEach(async () => {
	// The fetcher mock's call history must not carry over: several tests assert it was or was not called
	vi.clearAllMocks();
	vi.stubGlobal("luna", { assertDownloadPath });
	dir = await mkdtemp(join(tmpdir(), "luna-download-"));
});
afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(dir, { recursive: true, force: true });
});

const btsInfo = (trackId: redux.ItemId): PlaybackInfo =>
	({
		trackId,
		manifestMimeType: "application/vnd.tidal.bts",
		manifest: { mimeType: "audio/flac", urls: ["https://cdn.example/1"] },
	}) as unknown as PlaybackInfo;
const dashInfo = (trackId: redux.ItemId): PlaybackInfo =>
	({ trackId, manifestMimeType: "application/dash+xml", manifest: { dash: true } }) as unknown as PlaybackInfo;
const hlsInfo = (videoId: redux.ItemId): VideoPlaybackInfo =>
	({
		videoId,
		manifestMimeType: "application/vnd.tidal.emu",
		manifest: { urls: ["https://cdn.example/v.m3u8"] },
	}) as unknown as VideoPlaybackInfo;

/** Serve the given chunks, counting them into the progress object the caller passes to the real fetcher */
const serve = (chunks: string[], total: number, gate?: Promise<void>) => {
	fetchStream.mockImplementationOnce(async (_info, options) => {
		Object.assign(options!.progress!, { total, downloaded: 0 });
		return Readable.from(
			(async function* () {
				for (const [index, chunk] of chunks.entries()) {
					// FetchProgress fields are readonly: the real fetcher counts into the object it was handed
					Object.assign(options!.progress!, { downloaded: (options!.progress!.downloaded ?? 0) + chunk.length });
					yield Buffer.from(chunk);
					// Hold the stream open after the first chunk so progress is observable mid-download
					if (index === 0 && gate !== undefined) await gate;
				}
			})(),
			{ objectMode: false },
		);
	});
};

describe("download", () => {
	test("writes nothing where the user did not pick: the sanitized path and the one asked for are checked first", async () => {
		const trackId = nextId();
		assertDownloadPath.mockImplementationOnce(() => {
			throw new Error("not a download folder");
		});

		await expect(download(btsInfo(trackId), join(dir, "bad:name.flac"))).rejects.toThrow("not a download folder");

		expect(assertDownloadPath).toHaveBeenCalledWith(join(dir, "badname.flac"), join(dir, "bad:name.flac"));
		expect(fetchStream).not.toHaveBeenCalled();
		expect(await readdir(dir)).toEqual([]);
	});

	test("streams the file to disk, reporting progress by item id while it runs", async () => {
		const trackId = nextId();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		serve(["first ", "second"], 12, gate);

		const pending = download(btsInfo(trackId), join(dir, "track.flac"));

		await vi.waitFor(async () => expect(await downloadProgress(trackId)).toEqual({ total: 12, downloaded: 6 }));
		release();

		await expect(pending).resolves.toBe(join(dir, "track.flac"));
		expect(await readFile(join(dir, "track.flac"), "utf8")).toBe("first second");
		// The progress entry is dropped once the download settles
		expect(await downloadProgress(trackId)).toBeUndefined();
		expect(fetchStream).toHaveBeenCalledTimes(1);
		expect(finalizeDash).not.toHaveBeenCalled();
	});

	test("handles the tags it is given to the fetcher, and a DASH download is remuxed after it lands", async () => {
		const trackId = nextId();
		const tags: MetaTags = { tags: { title: "A Track" }, coverUrl: "https://cover.example/a.png" };
		serve(["fragment"], 8);

		const path = await download(dashInfo(trackId), join(dir, "track.m4a"), tags);

		const [, options] = fetchStream.mock.calls[0];
		expect(options).toMatchObject({ tags });
		expect(await readFile(path, "utf8")).toBe("fragment");
		// The raw fragments are left untouched by the (stubbed) remuxer: it is handed the file that was written
		expect(finalizeDash).toHaveBeenCalledWith(path, tags, path);
		expect(finalizeHls).not.toHaveBeenCalled();
	});

	test("an HLS video download is keyed by its video id and remuxed as HLS", async () => {
		const videoId = nextId();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		serve(["segment"], 7, gate);
		const path = join(dir, "video.mp4");

		const pending = download(hlsInfo(videoId), path);

		await vi.waitFor(async () => expect(await downloadProgress(videoId)).toEqual({ total: 7, downloaded: 7 }));
		release();
		await expect(pending).resolves.toBe(path);

		expect(finalizeHls).toHaveBeenCalledWith(path, undefined, path);
		expect(finalizeDash).not.toHaveBeenCalled();
		expect(await downloadProgress(videoId)).toBeUndefined();
		// It is not tracked under the nonexistent track id
		expect(await downloadProgress(videoId + 1)).toBeUndefined();
	});

	test("a name the filesystem cannot hold is sanitized, and an array path is joined", async () => {
		const trackId = nextId();
		serve(["audio"], 5);

		const path = await download(btsInfo(trackId), [dir, "an album", 'a:b*c?"d.flac']);

		// sanitize-filename strips the characters Windows and macOS reject
		expect(path).toBe(join(dir, "an album", "abcd.flac"));
		expect(await readFile(path, "utf8")).toBe("audio");
		// The directory was created for it
		expect(await readdir(join(dir, "an album"))).toEqual(["abcd.flac"]);
	});

	test("an existing file is not downloaded again", async () => {
		const trackId = nextId();
		const path = join(dir, "already-there.flac");
		await writeFile(path, "old audio");

		await expect(download(btsInfo(trackId), path)).resolves.toBe(path);

		expect(fetchStream).not.toHaveBeenCalled();
		expect(await readFile(path, "utf8")).toBe("old audio");
	});

	test("the existing file it skips is the sanitized one", async () => {
		const trackId = nextId();
		await writeFile(join(dir, "sanitized.flac"), "old audio");

		await expect(download(btsInfo(trackId), join(dir, "sanitized?.flac"))).resolves.toBe(join(dir, "sanitized.flac"));

		expect(fetchStream).not.toHaveBeenCalled();
	});

	test("a stream that fails removes the partial file, so the next attempt downloads again", async () => {
		const trackId = nextId();
		const path = join(dir, "retry.flac");
		fetchStream.mockImplementationOnce(async () => {
			return Readable.from(
				(async function* () {
					yield Buffer.from("partial");
					throw new Error("connection reset");
				})(),
				{ objectMode: false },
			);
		});

		await expect(download(btsInfo(trackId), path)).rejects.toThrow("connection reset");
		// Not left behind as a file that would be mistaken for a finished download
		expect(await readdir(dir)).toEqual([]);

		serve(["complete"], 8);
		await expect(download(btsInfo(trackId), path)).resolves.toBe(path);
		expect(await readFile(path, "utf8")).toBe("complete");
		expect(fetchStream).toHaveBeenCalledTimes(2);
	});

	test("the same item downloaded again after it finished is skipped rather than fetched twice", async () => {
		const trackId = nextId();
		const path = join(dir, "twice.flac");
		serve(["audio"], 5);
		await download(btsInfo(trackId), path);

		await expect(download(btsInfo(trackId), path)).resolves.toBe(path);

		expect(fetchStream).toHaveBeenCalledTimes(1);
	});
});
