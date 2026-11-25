import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	Conversion,
	FilePathSource,
	FlacOutputFormat,
	Input,
	Mp4OutputFormat,
	Output,
	type MetadataTags,
} from "mediabunny";
import { updateFile, type IPicture, type TagPatch } from "music-metadata/node";

import { readFile, rename, writeFile } from "fs/promises";

import { fetchTidal } from "../../../../lib.native/src/request/guards";
import type { MetaTags } from "./MediaItem.tags";

/**
 * DASH streams are downloaded by concatenating the raw CMAF segments, which produces a
 * fragmented MP4 that most taggers (and some players) can't handle. This module remuxes
 * the download into a standard progressive MP4 - preserving the AAC encoder delay
 * (edit list) so the audio stays sample-identical - and then writes the tags.
 * Lossless streams (FLAC in MP4) are remuxed into a native FLAC file instead.
 */

// #region MP4 box helpers
type Box = { type: string; start: number; size: number };

/** Iterate boxes in buf between [start, end) */
const listBoxes = (buf: Buffer, start: number, end: number): Box[] => {
	const boxes: Box[] = [];
	let pos = start;
	while (pos + 8 <= end) {
		let size: number = buf.readUInt32BE(pos);
		if (size === 1) size = Number(buf.readBigUInt64BE(pos + 8));
		else if (size === 0) size = end - pos;
		boxes.push({ type: buf.toString("latin1", pos + 4, pos + 8), start: pos, size });
		pos += size;
	}
	return boxes;
};

const findBox = (buf: Buffer, start: number, end: number, type: string): Box | undefined =>
	listBoxes(buf, start, end).find((box) => box.type === type);

/** Descend a path of container boxes, e.g. ["mdia", "minf", "stbl"] */
const findPath = (buf: Buffer, start: number, end: number, path: string[]): Box | undefined => {
	let box: Box | undefined = undefined;
	for (const type of path) {
		box = findBox(buf, start, end, type);
		if (box === undefined) return undefined;
		start = box.start + 8;
		end = box.start + box.size;
	}
	return box;
};

/** Read the first elst entry's media_time (the AAC encoder delay) from the source, if any */
const readMediaTime = (buf: Buffer): number | undefined => {
	const moov = findBox(buf, 0, buf.length, "moov");
	if (moov === undefined) return undefined;
	const elst = findPath(buf, moov.start + 8, moov.start + moov.size, ["trak", "edts", "elst"]);
	if (elst === undefined) return undefined;
	const version = buf.readUInt8(elst.start + 8);
	const entryCount = buf.readUInt32BE(elst.start + 12);
	if (entryCount < 1) return undefined;
	const mediaTime = version === 1 ? Number(buf.readBigInt64BE(elst.start + 16 + 8)) : buf.readInt32BE(elst.start + 16 + 4);
	return mediaTime > 0 ? mediaTime : undefined;
};

type FullBoxTimes = { version: number; timescale?: number; duration: number; durationOffset: number };

/** Read timescale+duration (and the duration field offset) from an mvhd/tkhd/mdhd fullbox */
const readTimes = (buf: Buffer, box: Box): FullBoxTimes => {
	const version = buf.readUInt8(box.start + 8);
	const base = box.start + 12;
	if (box.type === "mvhd" || box.type === "mdhd") {
		const timescaleOffset = version === 1 ? base + 16 : base + 8;
		const durationOffset = timescaleOffset + 4;
		return {
			version,
			timescale: buf.readUInt32BE(timescaleOffset),
			duration: version === 1 ? Number(buf.readBigUInt64BE(durationOffset)) : buf.readUInt32BE(durationOffset),
			durationOffset,
		};
	}
	// tkhd: creation, modification, track_id, reserved, duration
	const durationOffset = version === 1 ? base + 24 : base + 16;
	return {
		version,
		duration: version === 1 ? Number(buf.readBigUInt64BE(durationOffset)) : buf.readUInt32BE(durationOffset),
		durationOffset,
	};
};

const writeDuration = (buf: Buffer, times: FullBoxTimes, value: number): void => {
	if (times.version === 1) buf.writeBigUInt64BE(BigInt(value), times.durationOffset);
	else buf.writeUInt32BE(value, times.durationOffset);
};

/** edts { elst v0 [ segment_duration, media_time, rate 1.0 ] } */
const buildEdts = (segmentDuration: number, mediaTime: number): Buffer => {
	const edts = Buffer.alloc(36);
	edts.writeUInt32BE(36, 0);
	edts.write("edts", 4, "latin1");
	edts.writeUInt32BE(28, 8);
	edts.write("elst", 12, "latin1");
	edts.writeUInt32BE(0, 16); // version 0, flags 0
	edts.writeUInt32BE(1, 20); // entry_count
	edts.writeUInt32BE(segmentDuration, 24);
	edts.writeInt32BE(mediaTime, 28);
	edts.writeUInt16BE(1, 32); // media_rate_integer
	edts.writeUInt16BE(0, 34); // media_rate_fraction
	return edts;
};

/**
 * Insert an edts/elst into the muxed output's trak replicating the source's encoder delay
 * (shrinking mvhd/tkhd to the trimmed presentation duration).
 * The muxer puts moov before mdat, so stco/co64 chunk offsets are shifted by the inserted bytes.
 */
const patchMoov = (buf: Buffer, mediaTime?: number): Buffer => {
	const moov = findBox(buf, 0, buf.length, "moov");
	const mdat = findBox(buf, 0, buf.length, "mdat");
	if (moov === undefined || mdat === undefined) throw new Error("Muxed file is missing moov/mdat");

	const trak = findBox(buf, moov.start + 8, moov.start + moov.size, "trak");
	const tkhd = trak && findBox(buf, trak.start + 8, trak.start + trak.size, "tkhd");
	const mvhd = findBox(buf, moov.start + 8, moov.start + moov.size, "mvhd");
	const mdhd = trak && findPath(buf, trak.start + 8, trak.start + trak.size, ["mdia", "mdhd"]);
	if (!trak || !tkhd || !mvhd || !mdhd) throw new Error("Muxed file is missing moov children");

	let edts: Buffer | undefined;
	if (mediaTime !== undefined && findBox(buf, trak.start + 8, trak.start + trak.size, "edts") === undefined) {
		const movie = readTimes(buf, mvhd);
		const media = readTimes(buf, mdhd);
		const track = readTimes(buf, tkhd);
		// Presentation duration = media duration minus the encoder delay, in movie timescale
		const presentation = Math.round(((media.duration - mediaTime) * movie.timescale!) / media.timescale!);
		if (presentation > 0 && presentation <= 0xffffffff) {
			writeDuration(buf, movie, presentation);
			writeDuration(buf, track, presentation);
			edts = buildEdts(presentation, mediaTime);
		}
	}
	if (edts === undefined) return buf;
	const inserted = edts.length;

	// Growing moov shifts mdat: fix up chunk offsets
	if (moov.start < mdat.start) {
		const stbl = findPath(buf, trak.start + 8, trak.start + trak.size, ["mdia", "minf", "stbl"]);
		const table = stbl && (findBox(buf, stbl.start + 8, stbl.start + stbl.size, "stco") ?? findBox(buf, stbl.start + 8, stbl.start + stbl.size, "co64"));
		if (table === undefined) throw new Error("Muxed file is missing stco/co64");
		const entryCount = buf.readUInt32BE(table.start + 12);
		for (let i = 0; i < entryCount; i++) {
			if (table.type === "stco") {
				const at = table.start + 16 + i * 4;
				buf.writeUInt32BE(buf.readUInt32BE(at) + inserted, at);
			} else {
				const at = table.start + 16 + i * 8;
				buf.writeBigUInt64BE(buf.readBigUInt64BE(at) + BigInt(inserted), at);
			}
		}
	}

	// edts goes right after tkhd and grows both trak and moov.
	const edtsAt = tkhd.start + tkhd.size;
	buf.writeUInt32BE(moov.size + inserted, moov.start);
	buf.writeUInt32BE(trak.size + inserted, trak.start);
	return Buffer.concat([buf.subarray(0, edtsAt), edts, buf.subarray(edtsAt)]);
};
// #endregion

// #region Tagging
const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);
const asArray = (value: string | string[] | undefined): string[] =>
	value === undefined ? [] : (Array.isArray(value) ? value : [value]).filter((entry) => entry !== "");
const asInt = (value: string | undefined): number | undefined => {
	if (value === undefined) return undefined;
	const parsed = parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
};
const asFloat = (value: string | undefined): number | undefined => {
	if (value === undefined) return undefined;
	const parsed = parseFloat(value);
	return Number.isFinite(parsed) ? parsed : undefined;
};
const yearFrom = (tags: MetaTags["tags"]): number | undefined => {
	const year = asInt(first(tags.year));
	if (year !== undefined && year > 0 && year <= 9999) return year;
	const date = first(tags.date);
	if (date !== undefined && date.length >= 4) {
		const dateYear = asInt(date.slice(0, 4));
		if (dateYear !== undefined && dateYear > 0 && dateYear <= 9999) return dateYear;
	}
	return undefined;
};

const writeTags = async (path: string, { tags, coverUrl }: MetaTags): Promise<void> => {
	// Fetch the cover before opening the file so a network failure can't interrupt the save
	let cover: IPicture | undefined;
	if (coverUrl !== undefined) {
		try {
			const res = await fetchTidal(coverUrl);
			if (res.ok) {
				cover = {
					data: new Uint8Array(await res.arrayBuffer()),
					type: "Cover (front)",
					format: res.headers.get("content-type") ?? "image/jpeg",
				};
			}
		} catch {}
	}

	const artists = asArray(tags.artist);
	const albumArtists = asArray(tags.albumArtist);
	const genres = asArray(tags.genres);
	const replayGain = asFloat(first(tags.REPLAYGAIN_TRACK_GAIN));
	const replayGainPeak = asFloat(first(tags.REPLAYGAIN_TRACK_PEAK));
	const patch: TagPatch = {
		title: first(tags.title),
		artist: artists.length > 0 ? artists.join(", ") : undefined,
		artists: artists.length > 0 ? artists : undefined,
		albumArtist: albumArtists.length > 0 ? albumArtists.join(", ") : undefined,
		albumArtists: albumArtists.length > 0 ? albumArtists : undefined,
		album: first(tags.album),
		year: yearFrom(tags),
		copyright: first(tags.copyright),
		comments: first(tags.comment),
		genres: genres.length > 0 ? genres : undefined,
		trackNumber: asInt(first(tags.trackNumber)),
		trackTotal: asInt(first(tags.totalTracks)),
		discNumber: asInt(first(tags.discNumber)),
		discTotal: asInt(first(tags.totalDiscs)),
		bpm: asInt(first(tags.bpm)),
		lyrics: first(tags.lyrics),
		isrcs: first(tags.isrc),
		mbRecordingId: first(tags.musicbrainz_trackid),
		mbReleaseId: first(tags.musicbrainz_albumid),
		replayGainTrackGain: replayGain !== undefined ? `${replayGain} dB` : undefined,
		replayGainTrackPeak: replayGainPeak !== undefined ? String(replayGainPeak) : undefined,
		picture: cover !== undefined ? [cover] : undefined,
	};
	// The writer detects the container from its bytes and creates MP4 metadata boxes when absent.
	await updateFile(path, patch);
};
// #endregion

/** Remux a raw DASH (fragmented MP4) download into a standard progressive MP4 (or native FLAC) and tag it */
export const finalizeDashDownload = async (path: string, tags?: MetaTags): Promise<void> => {
	const source = await readFile(path);

	const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(source) });
	const isFlac = (await input.getPrimaryAudioTrack())?.codec === "flac";
	const output = new Output({ format: isFlac ? new FlacOutputFormat() : new Mp4OutputFormat(), target: new BufferTarget() });
	await (await Conversion.init({ input, output })).execute();

	const remuxed = Buffer.from(output.target.buffer!);
	const muxed = isFlac ? remuxed : patchMoov(remuxed, readMediaTime(source));

	// Replace the raw download only once the remux fully succeeded
	const tmpPath = `${path}.tmp`;
	await writeFile(tmpPath, muxed);
	await rename(tmpPath, path);

	if (tags !== undefined) await writeTags(path, tags);
};

/** Keep HLS metadata in the remux pass, including its full release date and joined artist credit. */
const toMetadataTags = async ({ tags, coverUrl }: MetaTags): Promise<MetadataTags> => {
	const metadata: MetadataTags = {};
	const title = first(tags.title);
	if (title !== undefined) metadata.title = title;
	const artists = asArray(tags.artist);
	if (artists.length > 0) metadata.artist = artists.join(", ");
	const date = first(tags.date);
	if (date !== undefined && !isNaN(Date.parse(date))) metadata.date = new Date(date);
	if (coverUrl !== undefined) {
		try {
			const res = await fetchTidal(coverUrl);
			if (res.ok) {
				const mimeType = res.headers.get("content-type") ?? "image/jpeg";
				metadata.images = [{ data: new Uint8Array(await res.arrayBuffer()), mimeType, kind: "coverFront" }];
			}
		} catch {}
	}
	return metadata;
};

/** Remux a raw HLS (MPEG-TS) video download into a standard MP4 with tags */
export const finalizeHlsDownload = async (path: string, tags?: MetaTags): Promise<void> => {
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(path) });
	// Native code has no WritableStream, so FilePathTarget can't be used here
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	try {
		const metadataTags = tags !== undefined ? await toMetadataTags(tags) : undefined;
		await (await Conversion.init({ input, output, tags: metadataTags })).execute();
	} finally {
		input.dispose();
	}

	// Replace the raw download only once the remux fully succeeded
	const tmpPath = `${path}.tmp`;
	await writeFile(tmpPath, Buffer.from(output.target.buffer!));
	await rename(tmpPath, path);
};
