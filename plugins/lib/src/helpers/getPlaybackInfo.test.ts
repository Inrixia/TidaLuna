import { beforeEach, describe, expect, test, vi } from "vitest";

import { TidalApi, type PlaybackInfoResponse, type VideoPlaybackInfoResponse } from "../classes/TidalApi";

import { getPlaybackInfo, getVideoPlaybackInfo } from "./getPlaybackInfo";
import { parseDashManifest, type DashManifest } from "./parseDashManifest";

/**
 * `getPlaybackInfo` asks TIDAL for a stream and decodes the manifest that its mime type says it has: the BTS one is
 * base64 JSON, the DASH one is XML for the native parser. `parseDasha` is a `*.native.ts` export, which the plugin
 * build replaces with an async IPC stub, so mocking it is what a renderer actually calls.
 */
vi.mock("./parseDashManifest", async (importOriginal) => ({
	...await importOriginal<typeof import("./parseDashManifest")>(),
	parseDashManifest: vi.fn(),
}));
const parseDashMock = vi.mocked(parseDashManifest);

const encode = (manifest: unknown) => btoa(JSON.stringify(manifest));

const tidalManifest = {
	mimeType: "audio/flac",
	codecs: "flac",
	encryptionType: "NONE",
	keyId: "",
	urls: ["https://sp-ad-cf.audio.tidal.com/mediatracks/1.flac"],
};

const playbackInfoResponse = (fields: Partial<PlaybackInfoResponse> = {}): PlaybackInfoResponse => ({
	trackId: 315333,
	assetPresentation: "FULL",
	audioMode: "STEREO",
	audioQuality: "LOSSLESS",
	manifestMimeType: "application/vnd.tidal.bts",
	manifestHash: "manifest-hash",
	manifest: encode(tidalManifest),
	albumReplayGain: -6.2,
	albumPeakAmplitude: 0.98,
	trackReplayGain: -5.1,
	trackPeakAmplitude: 0.97,
	bitDepth: 24,
	sampleRate: 48000,
	...fields,
});

const videoPlaybackInfoResponse = (fields: Partial<VideoPlaybackInfoResponse> = {}): VideoPlaybackInfoResponse => ({
	videoId: 120000001,
	streamType: "onDemand",
	assetPresentation: "FULL",
	videoQuality: "HIGH",
	manifestMimeType: "application/vnd.tidal.emu",
	manifestHash: "video-manifest-hash",
	manifest: encode({ mimeType: "application/vnd.apple.mpegurl", urls: ["https://sp-ad-cf.audio.tidal.com/video/1.m3u8"] }),
	...fields,
});

beforeEach(() => {
	vi.restoreAllMocks();
	parseDashMock.mockReset();
});

describe("getPlaybackInfo", () => {
	test("is undefined when TIDAL has no stream for the item", async () => {
		const playbackInfo = vi.spyOn(TidalApi, "playbackInfo").mockResolvedValue(undefined);

		expect(await getPlaybackInfo(315333, "LOSSLESS")).toBeUndefined();
		expect(playbackInfo).toHaveBeenCalledWith(315333, "LOSSLESS");
	});

	test("decodes a BTS manifest and takes its mime type", async () => {
		const response = playbackInfoResponse();
		vi.spyOn(TidalApi, "playbackInfo").mockResolvedValue(response);

		const playbackInfo = await getPlaybackInfo(315334, "HI_RES_LOSSLESS");

		expect(playbackInfo).toEqual({ ...response, manifestMimeType: "application/vnd.tidal.bts", manifest: tidalManifest, mimeType: "audio/flac" });
		expect(parseDashMock).not.toHaveBeenCalled();
	});

	test("hands a DASH manifest to the native parser against TIDAL's ad CDN", async () => {
		const xml = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period id="0"/></MPD>`;
		vi.spyOn(TidalApi, "playbackInfo").mockResolvedValue(playbackInfoResponse({ manifestMimeType: "application/dash+xml", manifest: btoa(xml) }));
		const parsed = { periods: [] } as unknown as DashManifest;
		parseDashMock.mockReturnValue(parsed);

		const playbackInfo = await getPlaybackInfo(315335, "LOSSLESS");

		// The manifest is base64 in both cases; the decoded XML is parsed against the base TIDAL hands out its segments
		expect(parseDashMock).toHaveBeenCalledWith(xml, "https://sp-ad-cf.audio.tidal.com");
		expect(playbackInfo?.manifest).toBe(parsed);
		expect(playbackInfo?.mimeType).toBe("audio/mp4");
		expect(playbackInfo?.manifestMimeType).toBe("application/dash+xml");
	});

	test("throws for a manifest type it doesn't handle", async () => {
		vi
			.spyOn(TidalApi, "playbackInfo")
			.mockResolvedValue(playbackInfoResponse({ manifestMimeType: "application/x-mpegurl" as PlaybackInfoResponse["manifestMimeType"] }));

		await expect(getPlaybackInfo(315336, "LOSSLESS")).rejects.toThrow("Unsupported Stream Info manifest mime type: application/x-mpegurl");
		expect(parseDashMock).not.toHaveBeenCalled();
	});
});

describe("getVideoPlaybackInfo", () => {
	test("decodes an HLS video manifest", async () => {
		const response = videoPlaybackInfoResponse();
		vi.spyOn(TidalApi, "videoPlaybackInfo").mockResolvedValue(response);

		const playbackInfo = await getVideoPlaybackInfo(120000002, "LOW");

		expect(playbackInfo).toEqual({
			...response,
			manifest: { mimeType: "application/vnd.apple.mpegurl", urls: ["https://sp-ad-cf.audio.tidal.com/video/1.m3u8"] },
			mimeType: "video/mp4",
		});
	});

	test("passes the quality through and lets TIDAL's api default it", async () => {
		const videoPlaybackInfo = vi.spyOn(TidalApi, "videoPlaybackInfo").mockResolvedValue(videoPlaybackInfoResponse());

		await getVideoPlaybackInfo(120000003, "MEDIUM");
		await getVideoPlaybackInfo(120000004);

		expect(videoPlaybackInfo.mock.calls).toEqual([
			[120000003, "MEDIUM"],
			[120000004, undefined],
		]);
	});

	test("is undefined when TIDAL has no stream for the video", async () => {
		vi.spyOn(TidalApi, "videoPlaybackInfo").mockResolvedValue(undefined);

		expect(await getVideoPlaybackInfo(120000005)).toBeUndefined();
	});

	test("throws for a video manifest type it doesn't handle", async () => {
		vi
			.spyOn(TidalApi, "videoPlaybackInfo")
			.mockResolvedValue(
				videoPlaybackInfoResponse({ manifestMimeType: "application/vnd.tidal.bts" as VideoPlaybackInfoResponse["manifestMimeType"] }),
			);

		await expect(getVideoPlaybackInfo(120000006)).rejects.toThrow("Unsupported Video Stream Info manifest mime type: application/vnd.tidal.bts");
	});
});
