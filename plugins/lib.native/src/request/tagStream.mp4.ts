// Stateless MP4 helpers for tagStream: box parsing, iTunes `ilst` tags, moov rewriting.
import type { MetaTags } from "../../../lib/src/classes/MediaItem/MediaItem.tags";

export type Mp4Header = {
	type: string;
	/** Box size including its header, 0 for a box running to the end of the file */
	size: number;
	/** Bytes of the header: 8, or 16 with a 64-bit size */
	headerSize: number;
};
export type Mp4Box = Mp4Header & { start: number; end: number };

/** The box header at `at`, undefined while `buf` doesn't hold all of it yet */
export const readHeader = (buf: Buffer, at = 0): Mp4Header | undefined => {
	if (buf.length - at < 8) return;
	const size = buf.readUInt32BE(at);
	const type = buf.toString("latin1", at + 4, at + 8);
	if (size !== 1) return { type, size, headerSize: 8 };
	if (buf.length - at < 16) return;
	return { type, size: Number(buf.readBigUInt64BE(at + 8)), headerSize: 16 };
};

/** The boxes in `buf[from..to)`, a box not fitting inside is an error */
export const parseBoxes = (buf: Buffer, from = 0, to = buf.length): Mp4Box[] => {
	const boxes: Mp4Box[] = [];
	for (let at = from; at < to;) {
		const header = readHeader(buf, at);
		if (header === undefined) throw new Error("Truncated MP4 box header");
		const size = header.size === 0 ? to - at : header.size;
		if (size < header.headerSize || at + size > to) throw new Error(`Invalid MP4 box ${header.type} size ${size}`);
		boxes.push({ ...header, size, start: at, end: at + size });
		at += size;
	}
	return boxes;
};

const u32 = (value: number) => {
	const buf = Buffer.alloc(4);
	buf.writeUInt32BE(value);
	return buf;
};
const box = (type: string, ...payload: Buffer[]) => {
	const length = payload.reduce((sum, part) => sum + part.length, 8);
	return Buffer.concat([u32(length), Buffer.from(type, "latin1"), ...payload], length);
};
/** A box with version + flags */
const fullBox = (type: string, ...payload: Buffer[]) => box(type, u32(0), ...payload);

/** `data` flags: https://developer.apple.com/documentation/quicktime-file-format/well-known_types */
const DataType = { implicit: 0, utf8: 1, jpeg: 13, png: 14, int: 21 } as const;
const dataBox = (type: number, payload: Buffer) => box("data", u32(type), u32(0), payload);
const textItem = (atom: string, values: string[]) => box(atom, ...values.map((value) => dataBox(DataType.utf8, Buffer.from(value, "utf8"))));
const freeformItem = (name: string, values: string[]) =>
	box(
		"----",
		fullBox("mean", Buffer.from("com.apple.iTunes")),
		fullBox("name", Buffer.from(name)),
		...values.map((value) => dataBox(DataType.utf8, Buffer.from(value))),
	);
/** trkn/disk: 2 reserved bytes, number, total, 2 reserved bytes (trkn only, harmless on disk) */
const pairItem = (atom: string, number: number, total: number) => {
	const payload = Buffer.alloc(8);
	payload.writeUInt16BE(number, 2);
	payload.writeUInt16BE(total, 4);
	return box(atom, dataBox(DataType.implicit, payload));
};

/** Tag key (FlacTags) to the iTunes text atom holding it */
const textAtoms: Record<string, string> = {
	title: "\xA9nam",
	artist: "\xA9ART",
	album: "\xA9alb",
	albumArtist: "aART",
	date: "\xA9day",
	copyright: "cprt",
	genres: "\xA9gen",
	lyrics: "\xA9lyr",
	comment: "\xA9cmt",
};
/** Tag key to the name of its `----:com.apple.iTunes:<name>` freeform atom */
const freeformNames: Record<string, string> = {
	isrc: "ISRC",
	upc: "UPC",
	organization: "LABEL",
	musicbrainz_trackid: "MusicBrainz Track Id",
	musicbrainz_albumid: "MusicBrainz Album Id",
	REPLAYGAIN_TRACK_GAIN: "REPLAYGAIN_TRACK_GAIN",
	REPLAYGAIN_TRACK_PEAK: "REPLAYGAIN_TRACK_PEAK",
};

/** The `ilst` box of `tags` and the cover image */
export const buildIlst = (tags: MetaTags["tags"], cover?: Buffer): Buffer => {
	const values = (key: string): string[] => {
		const value = (tags as Record<string, string[] | string | undefined>)[key];
		return (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter((v) => v !== "");
	};
	const items: Buffer[] = [];
	for (const [key, atom] of Object.entries(textAtoms)) {
		const list = key === "date" && values(key).length === 0 ? values("year") : values(key);
		if (list.length > 0) items.push(textItem(atom, list));
	}
	const [track] = values("trackNumber");
	if (track !== undefined) items.push(pairItem("trkn", parseInt(track, 10) || 0, parseInt(values("totalTracks")[0] ?? "0", 10) || 0));
	const [disc] = values("discNumber");
	if (disc !== undefined) items.push(pairItem("disk", parseInt(disc, 10) || 0, 0));
	const [bpm] = values("bpm");
	if (bpm !== undefined)
		items.push(box("tmpo", dataBox(DataType.int, Buffer.from([(parseInt(bpm, 10) || 0) >> 8, (parseInt(bpm, 10) || 0) & 0xff]))));
	for (const [key, name] of Object.entries(freeformNames)) {
		const list = values(key);
		if (list.length > 0) items.push(freeformItem(name, list));
	}
	if (cover !== undefined) {
		const png = cover.length > 3 && cover.readUInt32BE(0) === 0x89504e47;
		items.push(box("covr", dataBox(png ? DataType.png : DataType.jpeg, cover)));
	}
	return box("ilst", ...items);
};

const containers = new Set(["moov", "trak", "mdia", "minf", "stbl"]);
/** Adds `delta` to every `stco`/`co64` chunk offset in `buf[from..to)`, in place */
const shiftOffsets = (buf: Buffer, from: number, to: number, delta: number) => {
	for (const { type, start, headerSize, end } of parseBoxes(buf, from, to)) {
		const body = start + headerSize;
		if (containers.has(type)) shiftOffsets(buf, body, end, delta);
		else if (type === "stco" || type === "co64") {
			const count = buf.readUInt32BE(body + 4);
			const entry = type === "stco" ? 4 : 8;
			for (let i = 0, at = body + 8; i < count; i++, at += entry) {
				if (type === "co64") buf.writeBigUInt64BE(buf.readBigUInt64BE(at) + BigInt(delta), at);
				else {
					const offset = buf.readUInt32BE(at) + delta;
					if (offset < 0 || offset > 0xffffffff) throw new Error("MP4 chunk offset out of range after tagging");
					buf.writeUInt32BE(offset, at);
				}
			}
		}
	}
};

const hdlr = fullBox("hdlr", u32(0), Buffer.from("mdirappl"), Buffer.alloc(9));

/**
 * `moov` (a whole box) with its `udta/meta/ilst` replaced by `ilst`. Other `udta` children are kept, the old `meta` is dropped.
 * When `shiftChunkOffsets`, chunk offsets move by the size change (mdat follows moov, so it moved too).
 */
export const retagMoov = (moov: Buffer, ilst: Buffer, shiftChunkOffsets: boolean): Buffer => {
	const [{ headerSize }] = parseBoxes(moov);
	const parts: Buffer[] = [];
	const udtaKept: Buffer[] = [];
	for (const child of parseBoxes(moov, headerSize)) {
		if (child.type !== "udta") parts.push(moov.subarray(child.start, child.end));
		else
			for (const inner of parseBoxes(moov, child.start + child.headerSize, child.end))
				if (inner.type !== "meta") udtaKept.push(moov.subarray(inner.start, inner.end));
	}
	const out = box("moov", ...parts, box("udta", ...udtaKept, fullBox("meta", hdlr, ilst)));
	if (shiftChunkOffsets) shiftOffsets(out, 8, out.length, out.length - moov.length);
	return out;
};
