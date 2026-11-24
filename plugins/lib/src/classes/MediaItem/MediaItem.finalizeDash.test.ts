import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { BufferTarget, CmafOutputFormat, EncodedAudioPacketSource, EncodedPacket, MpegTsOutputFormat, Output } from "mediabunny";
import { File as TagFile } from "node-taglib-sharp";

import { finalizeDashDownload, finalizeHlsDownload } from "./MediaItem.finalizeDash.native";

// The cover is fetched through the main-process guard (request/guards.ts); let it use the stubbed global fetch
vi.mock("../../../../lib.native/src/request/guards", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../../lib.native/src/request/guards")>();
	return { ...actual, fetchTidal: (url: string) => fetch(url) };
});

import type { MetaTags } from "./MediaItem.tags";

/**
 * A DASH download is a concatenation of raw CMAF fragments, which `finalizeDashDownload` remuxes into a standard
 * progressive MP4 (or, for lossless streams, into a native FLAC file) and then tags. The fixtures below are real
 * fragmented files built with the same muxer the remuxer uses, so the box surgery and the tag writing run for real:
 * tags are read back with node-taglib-sharp, and the odd shapes (a cover that won't download, a file that isn't
 * media) are the ones the download path has to survive.
 */

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "luna-finalize-"));
});
afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(dir, { recursive: true, force: true });
});

/** 1x1 PNG: node-taglib-sharp sniffs image formats, so the cover has to be a real one */
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

const stubCover = (body: Buffer = png, contentType = "image/png") =>
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(new Uint8Array(body), { status: 200, headers: { "content-type": contentType } })),
	);

const AAC_ASC = new Uint8Array([0x12, 0x10]); // AAC-LC, 44.1kHz, stereo
const AAC_CONFIG = { codec: "mp4a.40.2", description: AAC_ASC, numberOfChannels: 2, sampleRate: 44_100 };

/** A CMAF (fragmented MP4) AAC file: init segment followed by its media fragments, as a DASH download looks */
const cmafAac = async (packets = 40, duration = 1024 / 44_100): Promise<Buffer> => {
	const init = new BufferTarget();
	const output = new Output({ format: new CmafOutputFormat(), target: new BufferTarget(), initTarget: init });
	const source = new EncodedAudioPacketSource("aac");
	output.addAudioTrack(source);
	await output.start();
	for (let i = 0; i < packets; i++) {
		const packet = new EncodedPacket(new Uint8Array(64).fill(0x21), "key", i * duration, duration);
		await source.add(packet, i === 0 ? { decoderConfig: AAC_CONFIG } : undefined);
	}
	await output.finalize();
	return Buffer.concat([Buffer.from(init.buffer!), Buffer.from(output.target.buffer!)]);
};

/** An HLS/MPEG-TS segment holding ADTS-framed AAC, as `finalizeHlsDownload` receives for video downloads */
const mpegTsAac = async (frames = 20): Promise<Buffer> => {
	const output = new Output({ format: new MpegTsOutputFormat(), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource("aac");
	output.addAudioTrack(source);
	await output.start();
	for (let i = 0; i < frames; i++) {
		const payload = new Uint8Array(32).fill(0x33);
		const header = Buffer.alloc(7);
		const frameLength = header.length + payload.length;
		header[0] = 0xff;
		header[1] = 0xf1; // MPEG-4, layer 0, no CRC
		header[2] = (0x01 << 6) | (0x04 << 2); // AAC-LC, 44.1kHz
		header[3] = (0x02 << 6) | ((frameLength >> 11) & 0x03); // stereo
		header[4] = (frameLength >> 3) & 0xff;
		header[5] = ((frameLength & 0x07) << 5) | 0x1f; // buffer fullness (VBR)
		header[6] = 0xfc;
		const packet = new EncodedPacket(new Uint8Array(Buffer.concat([header, payload])), "key", (i * 1024) / 44_100, 1024 / 44_100);
		await source.add(packet, i === 0 ? { decoderConfig: AAC_CONFIG } : undefined);
	}
	await output.finalize();
	return Buffer.from(output.target.buffer!);
};

/** Top-level MP4 boxes, in file order */
const topLevelBoxes = (file: Buffer): { type: string; start: number; size: number }[] => {
	const boxes: { type: string; start: number; size: number }[] = [];
	let pos = 0;
	while (pos + 8 <= file.length) {
		const size = file.readUInt32BE(pos);
		boxes.push({ type: file.toString("latin1", pos + 4, pos + 8), start: pos, size });
		if (size < 8) break;
		pos += size;
	}
	return boxes;
};

/** Boxes inside [start, end): enough to walk a fixture's moov into its track */
const boxesIn = (buf: Buffer, start: number, end: number): { type: string; start: number; size: number }[] => {
	const boxes: { type: string; start: number; size: number }[] = [];
	let pos = start;
	while (pos + 8 <= end) {
		const size = buf.readUInt32BE(pos);
		boxes.push({ type: buf.toString("latin1", pos + 4, pos + 8), start: pos, size });
		if (size < 8) break;
		pos += size;
	}
	return boxes;
};

/** Descend a path of container boxes, e.g. ["moov", "trak", "edts"] */
const findPath = (buf: Buffer, path: string[]) => {
	let start = 0;
	let end = buf.length;
	let box: { type: string; start: number; size: number } | undefined;
	for (const type of path) {
		box = boxesIn(buf, start, end).find((candidate) => candidate.type === type);
		if (box === undefined) return undefined;
		start = box.start + 8;
		end = box.start + box.size;
	}
	return box;
};

/** Splice `box` into a container after a sibling, growing the containers around it (fixture surgery) */
const insertBox = (buf: Buffer, containerPath: string[], afterType: string, box: Buffer): Buffer => {
	let start = 0;
	let end = buf.length;
	for (const type of containerPath) {
		const found = boxesIn(buf, start, end).find((candidate) => candidate.type === type);
		if (found === undefined) throw new Error(`fixture has no ${type}`);
		start = found.start + 8;
		end = found.start + found.size;
	}
	const sibling = boxesIn(buf, start, end).find((candidate) => candidate.type === afterType);
	if (sibling === undefined) throw new Error(`fixture has no ${afterType}`);
	const at = sibling.start + sibling.size;
	const spliced = Buffer.concat([buf.subarray(0, at), box, buf.subarray(at)]);
	// The insertion point is past every container's start, so their offsets hold: only their sizes grow
	for (let depth = 1; depth <= containerPath.length; depth++) {
		const container = findPath(spliced, containerPath.slice(0, depth));
		if (container !== undefined) spliced.writeUInt32BE(container.size + box.length, container.start);
	}
	return spliced;
};

/** edts { elst v0 [ segment_duration, media_time, rate 1.0 ] } */
const editListBox = (segmentDuration: number, mediaTime: number): Buffer => {
	const edts = Buffer.alloc(36);
	edts.writeUInt32BE(36, 0);
	edts.write("edts", 4, "latin1");
	edts.writeUInt32BE(28, 8);
	edts.write("elst", 12, "latin1");
	edts.writeUInt32BE(1, 20); // entry_count
	edts.writeUInt32BE(segmentDuration, 24);
	edts.writeInt32BE(mediaTime, 28);
	edts.writeUInt16BE(1, 32); // media_rate_integer
	return edts;
};

/** The 42-byte FLAC decoder description: "fLaC", a STREAMINFO block header and its body */
const flacDescription = (totalSamples: number): Uint8Array => {
	const streamInfo = Buffer.alloc(34);
	streamInfo.writeUInt16BE(4096, 0);
	streamInfo.writeUInt16BE(4096, 2);
	// sampleRate (20 bits) | channels - 1 (3 bits) | bitsPerSample - 1 (5 bits) | totalSamples (36 bits)
	streamInfo.writeBigUInt64BE((44_100n << 44n) | (1n << 41n) | (15n << 36n) | BigInt(totalSamples), 10);
	return new Uint8Array(Buffer.concat([Buffer.from("fLaC", "latin1"), Buffer.from([0x80, 0x00, 0x00, 0x22]), streamInfo]));
};

/** A CMAF FLAC-in-MP4 file, as a lossless DASH download looks */
const cmafFlac = async (frames = 16): Promise<Buffer> => {
	const init = new BufferTarget();
	const output = new Output({ format: new CmafOutputFormat(), target: new BufferTarget(), initTarget: init });
	const source = new EncodedAudioPacketSource("flac");
	output.addAudioTrack(source);
	await output.start();
	const decoderConfig = { codec: "flac", description: flacDescription(frames * 4096), numberOfChannels: 2, sampleRate: 44_100 };
	for (let i = 0; i < frames; i++) {
		const packet = new EncodedPacket(new Uint8Array(128).fill(0x44), "key", (i * 4096) / 44_100, 4096 / 44_100);
		await source.add(packet, i === 0 ? { decoderConfig } : undefined);
	}
	await output.finalize();
	return Buffer.concat([Buffer.from(init.buffer!), Buffer.from(output.target.buffer!)]);
};

/** Read a tag through node-taglib-sharp with the reader the file's container needs */
const readTags = <T>(path: string, mimeType: string, read: (tag: any) => T): T => {
	const file = TagFile.createFromPath(path, mimeType);
	try {
		return read(file.tag);
	} finally {
		file.dispose();
	}
};

const metaTags = (overrides: Partial<MetaTags["tags"]> = {}, cover = true): MetaTags => ({
	tags: {
		title: "Track Title",
		artist: ["Artist One", "Artist Two"],
		albumArtist: ["Album Artist"],
		album: "Album Title",
		year: "1998",
		date: "1998-07-21",
		copyright: "(C) 1998 A Label",
		comment: "https://tidal.com/browse/track/1",
		genres: "Electronic",
		trackNumber: "3",
		totalTracks: "12",
		discNumber: "2",
		bpm: "128",
		isrc: "ABC123456789",
		REPLAYGAIN_TRACK_GAIN: "-7.35",
		REPLAYGAIN_TRACK_PEAK: "0.98765",
		...overrides,
	},
	coverUrl: cover ? "https://cover.example/art.png" : undefined,
});

describe("finalizeDashDownload", () => {
	test("a fragmented DASH download becomes a progressive MP4 with the tags in it", async () => {
		const path = join(dir, "track.m4a");
		await writeFile(path, await cmafAac());
		stubCover();

		await finalizeDashDownload(path, metaTags());

		const file = await readFile(path);
		const boxes = topLevelBoxes(file);
		expect(boxes[0].type).toBe("ftyp");
		// Progressive, not fragmented: the moov (and its chunk tables) sits before the media data
		const moov = boxes.findIndex((box) => box.type === "moov");
		expect(moov).toBeGreaterThan(0);
		expect(moov).toBeLessThan(boxes.findIndex((box) => box.type === "mdat"));
		expect(boxes.filter((box) => box.type === "moof")).toHaveLength(0);
		// The remux is written beside the download and renamed over it
		expect(await readdir(dir)).toEqual(["track.m4a"]);
		// The cover was fetched and attached
		expect(vi.mocked(fetch)).toHaveBeenCalledWith("https://cover.example/art.png");

		const tags = readTags(path, "taglib/m4a", (tag) => ({
			title: tag.title,
			performers: tag.performers,
			albumArtists: tag.albumArtists,
			album: tag.album,
			year: tag.year,
			track: tag.track,
			trackCount: tag.trackCount,
			disc: tag.disc,
			beatsPerMinute: tag.beatsPerMinute,
			copyright: tag.copyright,
			comment: tag.comment,
			genres: tag.genres,
			isrc: tag.isrc,
			pictures: tag.pictures.map((picture: any) => ({ type: picture.type, mimeType: picture.mimeType, dataLength: picture.data.length })),
		}));
		expect(tags).toEqual({
			title: "Track Title",
			performers: ["Artist One", "Artist Two"],
			albumArtists: ["Album Artist"],
			album: "Album Title",
			year: 1998,
			track: 3,
			trackCount: 12,
			disc: 2,
			beatsPerMinute: 128,
			copyright: "(C) 1998 A Label",
			comment: "https://tidal.com/browse/track/1",
			genres: ["Electronic"],
			isrc: "ABC123456789",
			// 3 = FrontCover in taglib-sharp's PictureType; the cover's own content type is kept
			pictures: [{ type: 3, mimeType: "image/png", dataLength: png.length }],
		});
	});

	test("the year falls back to the release date, and an empty artist adds nothing", async () => {
		const path = join(dir, "date-only.m4a");
		await writeFile(path, await cmafAac(8));
		const meta = metaTags({ year: undefined, date: "2001-05-04", artist: [], albumArtist: [], genres: "" }, false);
		const fetchSpy = vi.fn(async () => new Response(new Uint8Array(png), { status: 200 }));
		vi.stubGlobal("fetch", fetchSpy);

		await finalizeDashDownload(path, meta);

		// Nothing to fetch when the item has no cover
		expect(fetchSpy).not.toHaveBeenCalled();
		const tags = readTags(path, "taglib/m4a", (tag) => ({
			year: tag.year,
			performers: tag.performers,
			genres: tag.genres,
			pictures: tag.pictures.length,
		}));
		expect(tags.year).toBe(2001);
		expect(tags.performers).toEqual([]);
		expect(tags.genres).toEqual([]);
		expect(tags.pictures).toBe(0);
	});

	test("a cover that cannot be downloaded does not stop the file being tagged", async () => {
		const path = join(dir, "no-cover.m4a");
		await writeFile(path, await cmafAac(8));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);

		await finalizeDashDownload(path, metaTags());

		const tags = readTags(path, "taglib/m4a", (tag) => ({ title: tag.title, pictures: tag.pictures.length }));
		expect(tags.title).toBe("Track Title");
		expect(tags.pictures).toBe(0);
	});

	test("a file that is not media rejects and is left exactly as it was downloaded", async () => {
		const path = join(dir, "broken.m4a");
		const original = Buffer.from("this is not a fragmented mp4", "utf8");
		await writeFile(path, original);

		await expect(finalizeDashDownload(path)).rejects.toThrow();

		expect(await readFile(path)).toEqual(original);
		expect(await readdir(dir)).toEqual(["broken.m4a"]);
	});

	test("a lossless DASH stream becomes a native FLAC file with its tags", async () => {
		const path = join(dir, "lossless.flac");
		await writeFile(path, await cmafFlac(8));
		stubCover();

		await finalizeDashDownload(path, metaTags());

		const file = await readFile(path);
		// Not an MP4 remux: the FLAC-in-MP4 stream is written out as a native FLAC file
		expect(file.subarray(0, 4).toString("latin1")).toBe("fLaC");
		expect(await readdir(dir)).toEqual(["lossless.flac"]);

		const tags = readTags(path, "taglib/flac", (tag) => ({ title: tag.title, performers: tag.performers, album: tag.album, year: tag.year }));
		expect(tags).toEqual({ title: "Track Title", performers: ["Artist One", "Artist Two"], album: "Album Title", year: 1998 });
	});

	test("an AAC encoder delay in the source is carried into the muxed file as an edit list", async () => {
		const path = join(dir, "delay.m4a");
		// A DASH AAC stream normally starts with an edit list trimming the encoder's priming samples
		await writeFile(path, insertBox(await cmafAac(40), ["moov", "trak"], "tkhd", editListBox(1, 1024)));

		await finalizeDashDownload(path);

		const file = await readFile(path);
		const edts = findPath(file, ["moov", "trak", "edts"]);
		expect(edts).toBeDefined();
		const elst = boxesIn(file, edts!.start + 8, edts!.start + edts!.size).find((box) => box.type === "elst");
		expect(elst).toBeDefined();
		// The delay is reproduced verbatim so the audio stays sample-identical
		expect(file.readInt32BE(elst!.start + 16 + 4)).toBe(1024);

		// Growing the moov moved the media data, so the chunk offsets have to have moved with it
		const stco = findPath(file, ["moov", "trak", "mdia", "minf", "stbl", "stco"]);
		expect(stco).toBeDefined();
		const mdat = topLevelBoxes(file).find((box) => box.type === "mdat")!;
		const firstChunkOffset = file.readUInt32BE(stco!.start + 16);
		expect(firstChunkOffset).toBeGreaterThanOrEqual(mdat.start);
		expect(firstChunkOffset).toBeLessThan(mdat.start + mdat.size);
	});

	test("a download with no tags is still remuxed", async () => {
		const path = join(dir, "tags-later.m4a");
		await writeFile(path, await cmafAac(8));

		await finalizeDashDownload(path);

		const file = await readFile(path);
		expect(file.subarray(4, 8).toString("latin1")).toBe("ftyp");
		expect(topLevelBoxes(file).map((box) => box.type)).toContain("moov");
	});
});

describe("finalizeHlsDownload", () => {
	const hlsMeta = (overrides: Partial<MetaTags["tags"]> = {}, cover = true): MetaTags => ({
		tags: { title: "Video Title", artist: ["Artist One", "Artist Two"], date: "2019-11-02", ...overrides },
		coverUrl: cover ? "https://cover.example/art.png" : undefined,
	});

	test("an MPEG-TS download becomes an MP4 with the tags the muxer can write", async () => {
		const path = join(dir, "video.mp4");
		await writeFile(path, await mpegTsAac());
		stubCover();

		await finalizeHlsDownload(path, hlsMeta());

		const file = await readFile(path);
		expect(file.subarray(4, 8).toString("latin1")).toBe("ftyp");
		expect(await readdir(dir)).toEqual(["video.mp4"]);

		const tags = readTags(path, "taglib/m4a", (tag) => ({
			title: tag.title,
			performers: tag.performers,
			year: tag.year,
			pictures: tag.pictures.length,
		}));
		expect(tags.title).toBe("Video Title");
		// The tag format has one artist field, so the names are joined
		expect(tags.performers).toEqual(["Artist One, Artist Two"]);
		expect(tags.year).toBe(2019);
		expect(tags.pictures).toBe(1);
	});

	test("an unparseable date is dropped rather than failing the remux", async () => {
		const path = join(dir, "bad-date.mp4");
		await writeFile(path, await mpegTsAac(8));

		await finalizeHlsDownload(path, hlsMeta({ date: "not a date" }, false));

		const tags = readTags(path, "taglib/m4a", (tag) => ({ title: tag.title, year: tag.year }));
		expect(tags.title).toBe("Video Title");
		expect(tags.year).toBe(0);
	});

	test("a file that is not media rejects and keeps its bytes", async () => {
		const path = join(dir, "broken.mp4");
		const original = Buffer.from("not an mpeg-ts segment", "utf8");
		await writeFile(path, original);

		await expect(finalizeHlsDownload(path)).rejects.toThrow();

		expect(await readFile(path)).toEqual(original);
		expect(await readdir(dir)).toEqual(["broken.mp4"]);
	});

	test("a download with no tags is still remuxed", async () => {
		const path = join(dir, "untagged.mp4");
		await writeFile(path, await mpegTsAac(8));

		await finalizeHlsDownload(path);

		const file = await readFile(path);
		expect(file.subarray(4, 8).toString("latin1")).toBe("ftyp");
		expect(topLevelBoxes(file).some((box) => box.type === "moov")).toBe(true);
	});
});
