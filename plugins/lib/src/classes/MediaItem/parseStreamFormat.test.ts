import { describe, expect, test, vi } from "vitest";
import { Readable } from "stream";

import { BufferTarget, CmafOutputFormat, EncodedAudioPacketSource, EncodedPacket, Output } from "mediabunny";

import { fetchMediaItemStream } from "../../../../lib.native/src/index.native";

import { getStreamBytes, parseStreamFormat } from "./parseStreamFormat.native";

import type { TrackPlaybackInfo } from "../PlaybackInfo";

/**
 * `parseStreamFormat` reads the codec of a TIDAL stream without downloading it: the DASH init segment for
 * `application/dash+xml`, the first 8KB for BTS streams. The stream fetcher is the main-process module that talks to
 * TIDAL's CDN, so it is replaced here and the fixtures below are handed to the real `music-metadata` parser.
 */

vi.mock("../../../../lib.native/src/index.native", () => ({ fetchMediaItemStream: vi.fn() }));

const fetchStream = vi.mocked(fetchMediaItemStream);

/** A FLAC stream header (marker + STREAMINFO), which is all `music-metadata` needs for the BTS path */
const flacHeader = (sampleRate = 44_100, channels = 2, bitsPerSample = 16, totalSamples = 44_100 * 4): Buffer => {
	const streamInfo = Buffer.alloc(34);
	streamInfo.writeUInt16BE(4096, 0); // min block size
	streamInfo.writeUInt16BE(4096, 2); // max block size
	// sampleRate (20 bits) | channels - 1 (3 bits) | bitsPerSample - 1 (5 bits) | totalSamples (36 bits)
	const packed = (BigInt(sampleRate) << 44n) | (BigInt(channels - 1) << 41n) | (BigInt(bitsPerSample - 1) << 36n) | BigInt(totalSamples);
	streamInfo.writeBigUInt64BE(packed, 10);
	const blockHeader = Buffer.from([0x80, 0x00, 0x00, streamInfo.length]); // last metadata block, type 0 (STREAMINFO)
	// One bogus audio frame: the parser only looks at the metadata blocks for the format
	return Buffer.concat([Buffer.from("fLaC", "latin1"), blockHeader, streamInfo, Buffer.alloc(64, 0x5a)]);
};

/** A CMAF (fragmented) AAC init segment followed by its media fragments, as a DASH download begins */
const cmafAac = async (): Promise<Buffer> => {
	const init = new BufferTarget();
	const output = new Output({ format: new CmafOutputFormat(), target: new BufferTarget(), initTarget: init });
	const source = new EncodedAudioPacketSource("aac");
	output.addAudioTrack(source);
	await output.start();
	// AAC-LC, 44.1kHz, stereo AudioSpecificConfig ("mp4a.40.2" is the registry's codec string for "aac")
	const decoderConfig = { codec: "mp4a.40.2", description: new Uint8Array([0x12, 0x10]), numberOfChannels: 2, sampleRate: 44_100 };
	for (let i = 0; i < 4; i++) {
		const packet = new EncodedPacket(new Uint8Array(64).fill(0x21), "key", (i * 1024) / 44_100, 1024 / 44_100);
		await source.add(packet, i === 0 ? { decoderConfig } : undefined);
	}
	await output.finalize();
	return Buffer.concat([Buffer.from(init.buffer!), Buffer.from(output.target.buffer!)]);
};

const dashInfo = { manifestMimeType: "application/dash+xml", manifest: {} } as unknown as TrackPlaybackInfo;
const btsInfo = { manifestMimeType: "application/vnd.tidal.bts", manifest: { mimeType: "audio/flac" } } as unknown as TrackPlaybackInfo;

/** The fetcher mutates the progress object it is handed, as the real one does while streaming */
const serveStream = (data: Buffer, total: number) => {
	fetchStream.mockImplementationOnce(async (_info, options) => {
		// FetchProgress fields are readonly: the real fetcher counts into the object it was handed
		Object.assign(options!.progress!, { total });
		// Not object mode: the parser's tokenizer reads fixed-size chunks (as the real fetcher does)
		return Readable.from([data], { objectMode: false });
	});
};

describe("parseStreamFormat", () => {
	test("DASH streams are read from the init segment only, as audio/mp4", async () => {
		serveStream(await cmafAac(), 1234);

		const { format, bytes } = await parseStreamFormat(dashInfo);

		const [, options] = fetchStream.mock.calls[0];
		expect(fetchStream).toHaveBeenCalledTimes(1);
		expect(options).toMatchObject({ bytesWanted: undefined, initSegmentOnly: true });
		expect(options!.progress).toBeDefined();
		// The container is named for the parser, not taken from the manifest (DASH manifests have no mimeType)
		expect(format.container).toBe("iso5/iso6/mp41/cmfc/dash");
		expect(format.codec).toMatch(/mp4a|aac/i);
		expect(format.sampleRate).toBe(44_100);
		expect(format.numberOfChannels).toBe(2);
		// Bytes reported are what the fetcher counted, not the length of the segment parsed
		expect(bytes).toBe(1234);
	});

	test("BTS streams are read from the first 8KB with the manifest's own mime type", async () => {
		const data = flacHeader();
		serveStream(data, 8192);

		const { format, bytes } = await parseStreamFormat(btsInfo);

		const [, options] = fetchStream.mock.calls[0];
		expect(options).toMatchObject({ bytesWanted: 8192, initSegmentOnly: false });
		expect(format.codec).toBe("FLAC");
		expect(format.lossless).toBe(true);
		expect(format.sampleRate).toBe(44_100);
		expect(format.bitsPerSample).toBe(16);
		expect(bytes).toBe(8192);
	});

	test("a stream the parser cannot read rejects rather than reporting a format", async () => {
		serveStream(Buffer.from("not a media file", "utf8"), 16);

		await expect(parseStreamFormat(btsInfo)).rejects.toThrow();
	});
});

describe("getStreamBytes", () => {
	test("asks the fetcher for a HEAD and returns the total it counted after draining the stream", async () => {
		serveStream(Buffer.from("ignored", "utf8"), 424_242);

		await expect(getStreamBytes(btsInfo)).resolves.toBe(424_242);

		const [, options] = fetchStream.mock.calls[0];
		expect(options).toMatchObject({ reqInit: { method: "HEAD" } });
		expect(options!.progress).toBeDefined();
	});
});
