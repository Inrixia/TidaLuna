import { afterEach, describe, expect, it, vi } from "vitest";

import { ReactiveStore } from "@luna/core";

import { playbackFormats, playbackInfos } from "../../caches";
import type { PlaybackInfoResponse } from "../TidalApi";
import { TidalApi } from "../TidalApi";
import { extensionOf } from "./PlaybackInfo.manifest";
import { PlaybackInfo, type MediaFormat, type TrackPlaybackInfo } from "./index";

let idSeq = 700_000;
const nextId = () => ++idSeq;

const btsResponse = (trackId: number, mimeType: "audio/flac" | "audio/mp4" = "audio/flac"): PlaybackInfoResponse =>
	({
		trackId,
		audioQuality: mimeType === "audio/mp4" ? "HIGH" : "LOSSLESS",
		bitDepth: 16,
		sampleRate: 44_100,
		manifestMimeType: "application/vnd.tidal.bts",
		manifest: btoa(
			JSON.stringify({
				mimeType,
				codecs: mimeType === "audio/mp4" ? "mp4a.40.2" : "flac",
				encryptionType: "NONE",
				urls: ["https://sp-pr-cf.audio.tidal.com/1"],
			}),
		),
	}) as PlaybackInfoResponse;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("PlaybackInfo", () => {
	it("shares one in-flight playbackInfo lookup and drops rejected promises", async () => {
		const id = nextId();
		const spy = vi
			.spyOn(TidalApi, "playbackInfo")
			.mockRejectedValueOnce(new Error("transient network failure"))
			.mockResolvedValueOnce(btsResponse(id));
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(PlaybackInfo.get(id, "LOSSLESS")).rejects.toThrow("transient network failure");
		// Rejection removes the entry once sized
		await vi.waitFor(() => expect(playbackInfos.has(`${id}:LOSSLESS`)).toBe(false));

		const [first, second] = await Promise.all([PlaybackInfo.get(id, "LOSSLESS"), PlaybackInfo.get(id, "LOSSLESS")]);
		expect(first?.trackId).toBe(id);
		expect(second).toBe(first);
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("returns the same reactive format store to concurrent callers and persists mutations", async () => {
		const id = nextId();
		const key = `${id}:LOSSLESS`;
		const a = new PlaybackInfo(id, "LOSSLESS");
		const b = new PlaybackInfo(id, "LOSSLESS");

		const [formatA, formatB] = await Promise.all([a.format(), b.format()]);
		expect(formatB).toBe(formatA);

		const updates: MediaFormat[] = [];
		const unloads = new Set<() => void>();
		a.withFormat(unloads, (fmt) => updates.push({ ...fmt }));

		formatA.sampleRate = 96_000;
		await vi.waitFor(() => expect(updates.some((u) => u.sampleRate === 96_000)).toBe(true));

		const backing = await ReactiveStore.getStore("@luna/formats");
		await vi.waitFor(async () => expect(await backing.get(key)).toMatchObject({ sampleRate: 96_000 }));
		for (const fn of unloads) fn();
		expect(playbackFormats.has(key)).toBe(true);
	});

	it("maps BTS FLAC to flac and BTS AAC (audio/mp4) to m4a in extensionOf", () => {
		const flacInfo = { manifestMimeType: "application/vnd.tidal.bts", manifest: { mimeType: "audio/flac" } } as unknown as TrackPlaybackInfo;
		const aacInfo = { manifestMimeType: "application/vnd.tidal.bts", manifest: { mimeType: "audio/mp4" } } as unknown as TrackPlaybackInfo;
		expect(extensionOf(flacInfo)).toBe("flac");
		expect(extensionOf(aacInfo)).toBe("m4a");
	});
});
