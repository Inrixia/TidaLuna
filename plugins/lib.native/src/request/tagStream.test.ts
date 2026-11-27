import { Readable } from "stream";
import { describe, expect, test, vi } from "vitest";

vi.mock("./guards", () => ({
	fetchTidal: async () => new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])),
}));

import { parseBoxes, type Mp4Box } from "./tagStream.mp4";
import { tagStream } from "./tagStream";

const u32 = (n: number) => Buffer.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const box = (type: string, ...payload: Buffer[]) => {
	const body = Buffer.concat(payload);
	return Buffer.concat([u32(body.length + 8), Buffer.from(type, "latin1"), body]);
};
const stco = (offsets: number[]) => box("stco", u32(0), u32(offsets.length), ...offsets.map(u32));
const co64 = (offsets: number[]) =>
	box(
		"co64",
		u32(0),
		u32(offsets.length),
		...offsets.map((o) => {
			const b = Buffer.alloc(8);
			b.writeBigUInt64BE(BigInt(o));
			return b;
		}),
	);
const MDAT = Buffer.from("0123456789abcdefghij");
const ftyp = box("ftyp", Buffer.from("M4A \0\0\0\0M4A isom"));
/** moov with chunk offsets pointing at mdat bytes 0 and 10, `extra` goes in moov (e.g. an old udta) */
const moovOf = (chunkBox: (o: number[]) => Buffer, mdatStart: number, extra: Buffer[] = []) =>
	box("moov", box("mvhd", Buffer.alloc(8)), box("trak", box("mdia", box("minf", box("stbl", chunkBox([mdatStart, mdatStart + 10]))))), ...extra);
/** ftyp + moov + mdat, offsets computed against the final layout */
const faststart = (chunkBox: (o: number[]) => Buffer, extra: Buffer[] = []) => {
	const mdatStart = ftyp.length + moovOf(chunkBox, 0, extra).length + 8;
	return Buffer.concat([ftyp, moovOf(chunkBox, mdatStart, extra), box("mdat", MDAT)]);
};

const run = async (input: Buffer, tags = {}, format: "flac" | "m4a" = "m4a", chunk = 7, coverUrl?: string) => {
	const chunks: Buffer[] = [];
	for (let i = 0; i < input.length; i += chunk) chunks.push(input.subarray(i, i + chunk));
	const out = await tagStream(Readable.from(chunks, { objectMode: false }), { tags, coverUrl }, format);
	const parts: Buffer[] = [];
	for await (const part of out) parts.push(part);
	return Buffer.concat(parts);
};

const find = (buf: Buffer, path: string[], from = 0, to = buf.length): Mp4Box | undefined => {
	const [head, ...rest] = path;
	const hit = parseBoxes(buf, from, to).find((b) => b.type === head);
	if (hit === undefined || rest.length === 0) return hit;
	return find(buf, rest, hit.start + hit.headerSize + (head === "meta" ? 4 : 0), hit.end);
};
/** The text of the first data atom of each ilst item */
const readIlst = (buf: Buffer) => {
	const ilst = find(buf, ["moov", "udta", "meta", "ilst"])!;
	const items: Record<string, string> = {};
	for (const item of parseBoxes(buf, ilst.start + 8, ilst.end)) {
		const data = parseBoxes(buf, item.start + 8, item.end).filter((b) => b.type === "data");
		items[item.type] = buf.toString("utf8", data[0].start + 16, data[0].end);
	}
	return items;
};
const offsetsOf = (buf: Buffer, type: "stco" | "co64") => {
	const b = find(buf, ["moov", "trak", "mdia", "minf", "stbl", type])!;
	const count = buf.readUInt32BE(b.start + 12);
	return Array.from({ length: count }, (_, i) =>
		type === "stco" ? buf.readUInt32BE(b.start + 16 + i * 4) : Number(buf.readBigUInt64BE(b.start + 16 + i * 8)),
	);
};
const tags = {
	title: "Song",
	artist: ["A", "B"],
	album: "Alb",
	albumArtist: ["AA"],
	trackNumber: "3",
	totalTracks: "12",
	discNumber: "1",
	date: "2020-01-02",
	copyright: "(c)",
	isrc: "US123",
};

describe("tagStream m4a", () => {
	for (const [name, chunkBox, type] of [["stco", stco, "stco"] as const, ["co64", co64, "co64"] as const]) {
		test(`faststart ${name}: tags, shifted offsets, untouched mdat`, async () => {
			const input = faststart(chunkBox);
			const out = await run(input, tags);
			const items = readIlst(out);
			expect(items["\xA9nam"]).toBe("Song");
			expect(items["\xA9ART"]).toBe("A");
			expect(items["\xA9alb"]).toBe("Alb");
			expect(items["aART"]).toBe("AA");
			expect(items["\xA9day"]).toBe("2020-01-02");
			expect(items["cprt"]).toBe("(c)");
			expect(items["----"]).toContain("US123");
			const trkn = find(out, ["moov", "udta", "meta", "ilst", "trkn", "data"], 0)!;
			expect([out.readUInt16BE(trkn.start + 18), out.readUInt16BE(trkn.start + 20)]).toEqual([3, 12]);

			const grown = out.length - input.length;
			expect(grown).toBeGreaterThan(0);
			expect(offsetsOf(out, type)).toEqual(offsetsOf(input, type).map((o) => o + grown));
			for (const [i, o] of offsetsOf(out, type).entries())
				expect(out.toString("latin1", o, o + 10)).toBe(MDAT.toString("latin1", i * 10, i * 10 + 10));
			expect(out.subarray(out.length - MDAT.length).equals(MDAT)).toBe(true);
		});
	}

	test("replaces an existing udta/meta instead of duplicating it", async () => {
		const old = box(
			"udta",
			box("meta", u32(0), box("ilst", box("\xA9nam", box("data", u32(1), u32(0), Buffer.from("Old"))))),
			box("xtra", Buffer.from("keep")),
		);
		const out = await run(faststart(stco, [old]), tags);
		const moov = find(out, ["moov"])!;
		expect(parseBoxes(out, moov.start + 8, moov.end).filter((b) => b.type === "udta")).toHaveLength(1);
		expect(readIlst(out)["\xA9nam"]).toBe("Song");
		expect(find(out, ["moov", "udta", "xtra"])).toBeDefined();
	});

	test("embeds the cover", async () => {
		const out = await run(faststart(stco), tags, "m4a", 7, "https://resources.tidal.com/c.jpg");
		const data = find(out, ["moov", "udta", "meta", "ilst", "covr", "data"])!;
		expect(out.readUInt32BE(data.start + 8)).toBe(13);
		expect([...out.subarray(data.start + 16, data.end)]).toEqual([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
	});

	test("moov after mdat falls back to buffering and tags the same", async () => {
		const input = Buffer.concat([ftyp, box("mdat", MDAT), moovOf(stco, ftyp.length + 8)]);
		const out = await run(input, tags);
		expect(readIlst(out)).toEqual(readIlst(await run(faststart(stco), tags)));
		// mdat is before moov so its chunks did not move
		expect(offsetsOf(out, "stco")).toEqual(offsetsOf(input, "stco"));
		expect(out.subarray(ftyp.length, ftyp.length + 8 + MDAT.length).equals(input.subarray(ftyp.length, ftyp.length + 8 + MDAT.length))).toBe(true);
	});

	test("handles largesize and size 0 mdat", async () => {
		const mdatStart = ftyp.length + moovOf(stco, 0).length + 16;
		const large = Buffer.concat([
			ftyp,
			moovOf(stco, mdatStart),
			u32(1),
			Buffer.from("mdat"),
			Buffer.from([0, 0, 0, 0, 0, 0, 0, 16 + MDAT.length]),
			MDAT,
		]);
		const out = await run(large, tags);
		expect(out.subarray(out.length - MDAT.length).equals(MDAT)).toBe(true);
		expect(offsetsOf(out, "stco")[0]).toBe(out.length - MDAT.length);
		const toEnd = Buffer.concat([ftyp, moovOf(stco, mdatStart - 8), u32(0), Buffer.from("mdat"), MDAT]);
		const out2 = await run(toEnd, tags);
		expect(out2.subarray(out2.length - MDAT.length).equals(MDAT)).toBe(true);
		expect(offsetsOf(out2, "stco")[0]).toBe(out2.length - MDAT.length);
	});

	test("a source error destroys the output", async () => {
		const source = new Readable({ read() {} });
		source.push(ftyp);
		const out = await tagStream(source, { tags }, "m4a");
		const done = new Promise((resolve) => out.on("error", resolve));
		out.resume();
		source.destroy(new Error("boom"));
		expect(((await done) as Error).message).toBe("boom");
	});
});

describe("tagStream flac", () => {
	const streamInfo = Buffer.concat([Buffer.from([0x80, 0, 0, 34]), Buffer.alloc(34)]);
	const flac = Buffer.concat([Buffer.from("fLaC"), streamInfo, Buffer.from([0xff, 0xf8, 1, 2, 3, 4, 5, 6, 7, 8])]);

	test("adds a VORBIS_COMMENT block and keeps the audio", async () => {
		const out = await run(flac, { title: "Song", artist: ["A"] }, "flac");
		expect(out.toString("latin1")).toContain("TITLE=Song");
		expect(out.subarray(out.length - 10).equals(flac.subarray(flac.length - 10))).toBe(true);
		expect(out.subarray(0, 4).toString()).toBe("fLaC");
	});

	test("a source error destroys the output", async () => {
		const source = new Readable({ read() {} });
		const out = await tagStream(source, { tags }, "flac");
		const done = new Promise((resolve) => out.on("error", resolve));
		out.resume();
		source.destroy(new Error("boom"));
		expect(((await done) as Error).message).toBe("boom");
	});
});
