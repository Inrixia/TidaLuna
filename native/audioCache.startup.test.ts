import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import { setUserDataDir } from "../test/harness/electron";

/**
 * Native/audioCache.ts inherits whatever is in its folder when it starts, and that is the only moment the scan runs, so
 * this file fills the folder before importing it.
 *
 * The bug it pins was found in a real cache: a track by AC/DC was stored under `AC/DC - Through the Mists of Time.flac`,
 * which made a folder called `AC` in the cache. On the next start the scan tried to remove that folder as an unknown
 * entry, `rm` without `recursive` threw EISDIR, the error aborted the whole scan, and every cached track stopped
 * playing (TIDAL reported `network_error` with `playback_buffer_time: 0` for the tracks it had cached).
 */
const scratch = await mkdtemp(path.join(os.tmpdir(), "luna-audio-cache-startup-"));
setUserDataDir(scratch);
/** Created by native/audioCache.ts once electron is ready */
const cacheDir = path.join(scratch, "luna-audio-cache");

const kept = Buffer.from("0123456789");
/** The url the player would be given for this track, and the id the cache keys it by (sha1 of the path) */
const audioUrl = `https://sp-pr-f.audio.tidal.com/mediatracks/startup-track.flac?token=1700000000~signature`;
const trackId = createHash("sha1").update(new URL(audioUrl).pathname).digest("hex").slice(0, 32);

await mkdir(path.join(cacheDir, "AC"), { recursive: true });
// A track whose name held a separator, as the old naming made one: a folder in the cache, holding the audio
await writeFile(path.join(cacheDir, "AC", "DC - Through the Mists of Time [1].flac"), Buffer.alloc(4096));
// A healthy track, which must still be loaded whatever else is in the folder
await writeFile(path.join(cacheDir, "kept.flac"), kept);
await writeFile(path.join(cacheDir, `${trackId}.json`), JSON.stringify({ file: "kept.flac", size: kept.length, type: "audio/flac" }));

const { audioCachePersist, audioCacheStats, audioCacheStatus } = await import("./audioCache");

afterAll(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {});
});

test("a folder in the cache does not stop the other tracks loading", async () => {
	// The scan runs when the module is ready; persisting anything waits for it (a url that is not audio is a no-op)
	await audioCachePersist("https://example.com/not-audio.flac");

	const stats = await audioCacheStats();

	// The healthy track was kept and counted, so playback of it can be served
	expect(stats.files).toBe(1);
	expect(stats.usage).toBe(kept.length);
	expect(await audioCacheStatus(audioUrl)).toMatchObject({ complete: true, held: kept.length });

	// The scan also tried to remove the unknown folder. Whether the filesystem lets it (Windows can refuse with EPERM)
	// is not the point: it must not have taken the healthy track, or the scan, down with it
	expect(await readdir(cacheDir)).toContain("kept.flac");
});
