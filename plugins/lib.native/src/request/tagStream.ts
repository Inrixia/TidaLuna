import type { MetaTags } from "../../../lib/src/classes/MediaItem/MediaItem.tags";
import { pipeline, Readable, Transform, type TransformCallback } from "stream";

import { fetchTidal } from "./guards";
import { buildIlst, parseBoxes, readHeader, retagMoov } from "./tagStream.mp4";

import { rejectNotOk, toArrayBuffer } from "@inrixia/helpers";
import { FlacStreamTagger, PictureType } from "flac-stream-tagger";

/** The file extension of the stream, as `PlaybackInfo.fileExtension()` gives */
export type TagFormat = "flac" | "m4a";
export type StreamTags = { tags: MetaTags["tags"]; coverUrl?: string };

/**
 * Tags an MP4/M4A stream. When `moov` comes before `mdat` (faststart, the layout TIDAL serves AAC in) only the boxes before `mdat` are buffered,
 * rewritten with the tags and chunk offsets shifted, then `mdat` and the rest pass through untouched.
 */
class Mp4Tagger extends Transform {
	private mode: "head" | "mdat" | "tail" | "all" = "head";
	private pending: Buffer = Buffer.alloc(0);
	/** Top level boxes before mdat */
	private readonly head: Buffer[] = [];
	private moovIndex = -1;
	/** Bytes of mdat still to pass through, Infinity when it runs to the end of the file */
	private mdatLeft = 0;

	public constructor(private readonly ilst: Buffer) {
		super();
	}

	public override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
		try {
			this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
			this.consume();
			callback();
		} catch (err) {
			callback(err as Error);
		}
	}

	public override _flush(callback: TransformCallback) {
		try {
			if (this.mode === "head" || this.mode === "all") this.flushBuffered();
			callback();
		} catch (err) {
			callback(err as Error);
		}
	}

	private consume() {
		for (;;) {
			if (this.mode === "tail") {
				this.push(this.pending);
				this.pending = Buffer.alloc(0);
				return;
			}
			if (this.mode === "mdat") {
				const n = Math.min(this.mdatLeft, this.pending.length);
				if (n > 0) this.push(n === this.pending.length ? this.pending : this.pending.subarray(0, n));
				this.mdatLeft -= n;
				this.pending = this.pending.subarray(n);
				if (this.mdatLeft > 0) return;
				this.mode = "tail";
				continue;
			}
			if (this.mode === "all") return;

			const header = readHeader(this.pending);
			if (header === undefined) return;
			if (header.type === "mdat") {
				if (this.moovIndex === -1) {
					// shortcut: buffers the whole file when moov follows mdat, stream it if TIDAL ever serves such files
					this.pending = Buffer.concat([...this.head, this.pending]);
					this.head.length = 0;
					this.mode = "all";
					return;
				}
				this.emitHead(true);
				this.mdatLeft = header.size === 0 ? Infinity : header.size;
				this.mode = "mdat";
				continue;
			}
			// A box running to the end of the file can't be split from what follows, buffer it all
			if (header.size === 0) {
				this.pending = Buffer.concat([...this.head, this.pending]);
				this.head.length = 0;
				this.mode = "all";
				return;
			}
			if (this.pending.length < header.size) return;
			if (header.type === "moov") this.moovIndex = this.head.length;
			this.head.push(this.pending.subarray(0, header.size));
			this.pending = this.pending.subarray(header.size);
		}
	}

	private emitHead(moovBeforeMdat: boolean) {
		for (const [i, part] of this.head.entries()) this.push(i === this.moovIndex ? retagMoov(part, this.ilst, moovBeforeMdat) : part);
		this.head.length = 0;
	}

	/** The end of the stream with `moov` after `mdat` or no `mdat` at all */
	private flushBuffered() {
		if (this.mode === "head") {
			// Only boxes before any mdat: tag if there is a moov
			this.emitHead(false);
			this.push(this.pending);
			return;
		}
		const boxes = parseBoxes(this.pending);
		const moovIndex = boxes.findIndex((box) => box.type === "moov");
		if (moovIndex === -1) return void this.push(this.pending);
		const moovBeforeMdat = boxes.findIndex((box) => box.type === "mdat") > moovIndex;
		for (const [i, box] of boxes.entries()) {
			const bytes = this.pending.subarray(box.start, box.end);
			this.push(i === moovIndex ? retagMoov(bytes, this.ilst, moovBeforeMdat) : bytes);
		}
	}
}

const fetchCover = (coverUrl: string) =>
	fetchTidal(coverUrl)
		.then(rejectNotOk)
		.then(toArrayBuffer)
		.then((arrayBuffer) => Buffer.from(arrayBuffer))
		.catch(() => undefined);

/**
 * Tags a stream of untagged audio. The returned stream ends with the tagged file, source errors destroy it.
 * Async because the cover image is fetched first (a failed fetch tags without a cover).
 */
export const tagStream = async (source: Readable, { tags, coverUrl }: StreamTags, format: TagFormat): Promise<Readable> => {
	const cover = coverUrl === undefined ? undefined : await fetchCover(coverUrl);
	// pipeline forwards source errors to the tagger, pipe() would leave them unhandled
	switch (format) {
		case "flac": {
			const tagMap = Object.fromEntries(Object.entries(tags).filter(([, value]) => value !== undefined)) as Record<string, string[] | string>;
			const picture = cover === undefined ? undefined : { pictureType: PictureType.FrontCover, buffer: cover };
			return pipeline(source, new FlacStreamTagger({ tagMap, picture }), () => {});
		}
		case "m4a":
			return pipeline(source, new Mp4Tagger(buildIlst(tags, cover)), () => {});
		default:
			throw new Error(`Cannot tag format ${format satisfies never}`);
	}
};
