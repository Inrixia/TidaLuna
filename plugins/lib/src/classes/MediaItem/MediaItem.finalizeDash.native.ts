import { ALL_FORMATS, BufferSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output } from "mediabunny";
import { ByteVector, File as TagFile, Picture, PictureType } from "node-taglib-sharp";

import { readFile, rename, writeFile } from "fs/promises";

import type { MetaTags } from "./MediaItem.tags";

/**
 * DASH streams are downloaded by concatenating the raw CMAF segments, which produces a
 * fragmented MP4 that most taggers (and some players) can't handle. This module remuxes
 * the download into a standard progressive MP4 - preserving the AAC encoder delay
 * (edit list) so the audio stays sample-identical - and then writes the tags.
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
 * Empty udta > meta > hdlr(mdir/appl) > ilst skeleton.
 * node-taglib-sharp (up to at least 6.0.3) crashes saving a file with no Apple ilst box
 * (Mpeg4File.save dereferences an empty IsoUserDataBox's parentTree), so give it one to edit in place.
 */
const buildUdta = (): Buffer => {
	const udta = Buffer.alloc(61);
	udta.writeUInt32BE(61, 0);
	udta.write("udta", 4, "latin1");
	udta.writeUInt32BE(53, 8);
	udta.write("meta", 12, "latin1");
	udta.writeUInt32BE(0, 16); // meta version/flags
	udta.writeUInt32BE(33, 20);
	udta.write("hdlr", 24, "latin1");
	udta.writeUInt32BE(0, 28); // hdlr version/flags
	udta.writeUInt32BE(0, 32); // pre_defined
	udta.write("mdir", 36, "latin1");
	udta.write("appl", 40, "latin1");
	// 8 reserved bytes + 1 empty name byte, already zeroed
	udta.writeUInt32BE(8, 53);
	udta.write("ilst", 57, "latin1");
	return udta;
};

/**
 * Insert an edts/elst into the muxed output's trak replicating the source's encoder delay
 * (shrinking mvhd/tkhd to the trimmed presentation duration), and append the empty udta.
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
	const udta = buildUdta();
	const inserted = (edts?.length ?? 0) + udta.length;

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

	// edts goes right after tkhd, udta at the end of moov; both grow moov
	const edtsAt = tkhd.start + tkhd.size;
	const udtaAt = moov.start + moov.size;
	buf.writeUInt32BE(moov.size + inserted, moov.start);
	if (edts !== undefined) buf.writeUInt32BE(trak.size + edts.length, trak.start);
	return Buffer.concat(edts !== undefined ? [buf.subarray(0, edtsAt), edts, buf.subarray(edtsAt, udtaAt), udta, buf.subarray(udtaAt)] : [buf.subarray(0, udtaAt), udta, buf.subarray(udtaAt)]);
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
	let cover: Picture | undefined;
	if (coverUrl !== undefined) {
		try {
			const res = await fetch(coverUrl);
			if (res.ok) {
				cover = Picture.fromData(ByteVector.fromByteArray(Buffer.from(await res.arrayBuffer())));
				cover.type = PictureType.FrontCover;
				cover.mimeType = res.headers.get("content-type") ?? "image/jpeg";
			}
		} catch {}
	}

	let file: TagFile | undefined;
	try {
		file = TagFile.createFromPath(path);
		const tag = file.tag;

		const title = first(tags.title);
		if (title !== undefined) tag.title = title;
		const performers = asArray(tags.artist);
		if (performers.length > 0) tag.performers = performers;
		const albumArtists = asArray(tags.albumArtist);
		if (albumArtists.length > 0) tag.albumArtists = albumArtists;
		const album = first(tags.album);
		if (album !== undefined) tag.album = album;
		const year = yearFrom(tags);
		if (year !== undefined) tag.year = year;
		const copyright = first(tags.copyright);
		if (copyright !== undefined) tag.copyright = copyright;
		const comment = first(tags.comment);
		if (comment !== undefined) tag.comment = comment;
		const genres = asArray(tags.genres);
		if (genres.length > 0) tag.genres = genres;
		const trackNumber = asInt(first(tags.trackNumber));
		if (trackNumber !== undefined) tag.track = trackNumber;
		const totalTracks = asInt(first(tags.totalTracks));
		if (totalTracks !== undefined) tag.trackCount = totalTracks;
		const discNumber = asInt(first(tags.discNumber));
		if (discNumber !== undefined) tag.disc = discNumber;
		const bpm = asInt(first(tags.bpm));
		if (bpm !== undefined) tag.beatsPerMinute = bpm;
		const lyrics = first(tags.lyrics);
		if (lyrics !== undefined) tag.lyrics = lyrics;
		const isrc = first(tags.isrc);
		if (isrc !== undefined) tag.isrc = isrc;
		const musicBrainzTrackId = first(tags.musicbrainz_trackid);
		if (musicBrainzTrackId !== undefined) tag.musicBrainzTrackId = musicBrainzTrackId;
		const musicBrainzAlbumId = first(tags.musicbrainz_albumid);
		if (musicBrainzAlbumId !== undefined) tag.musicBrainzReleaseId = musicBrainzAlbumId;
		if (cover !== undefined) tag.pictures = [cover];

		file.save();
	} finally {
		file?.dispose();
	}
};
// #endregion

/** Remux a raw DASH (fragmented MP4) download into a standard progressive MP4 and tag it */
export const finalizeDashDownload = async (path: string, tags?: MetaTags): Promise<void> => {
	const source = await readFile(path);

	const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(source) });
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	await (await Conversion.init({ input, output })).execute();

	const muxed = patchMoov(Buffer.from(output.target.buffer!), readMediaTime(source));

	// Replace the raw download only once the remux fully succeeded
	const tmpPath = `${path}.tmp`;
	await writeFile(tmpPath, muxed);
	await rename(tmpPath, path);

	if (tags !== undefined) await writeTags(path, tags);
};
