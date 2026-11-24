import { describe, expect, test } from "vitest";

import type * as redux from "../redux";
import { Quality } from "./Quality";

/**
 * `min`/`max` read their arguments through `valueOf()`, and the constructor is private. A fabricated rank is how a
 * comparison against a value that has no `Quality` static is exercised.
 */
const fabricated = (idx: number) => ({ valueOf: () => idx }) as unknown as Quality;

describe("fromMetaTags", () => {
	test("no tags means no qualities", () => {
		expect(Quality.fromMetaTags()).toEqual([]);
		expect(Quality.fromMetaTags([])).toEqual([]);
	});

	test.each([
		["HIRES_LOSSLESS", Quality.HiRes],
		["MQA", Quality.MQA],
		["DOLBY_ATMOS", Quality.Atmos],
		["SONY_360RA", Quality.Sony630],
		["LOSSLESS", Quality.High],
	] as const)("maps %s to the matching quality", (tag, quality) => {
		expect(Quality.fromMetaTags([tag])).toEqual([quality]);
	});

	test("keeps tag order", () => {
		expect(Quality.fromMetaTags(["SONY_360RA", "HIRES_LOSSLESS", "LOSSLESS"])).toEqual([Quality.Sony630, Quality.HiRes, Quality.High]);
	});

	test("leaves a tag with no matching quality as an undefined entry", () => {
		// TIDAL can serve a tag Luna has no rank for; the entry is undefined rather than dropped
		expect(Quality.fromMetaTags(["NOT_A_TAG"] as unknown as redux.MediaMetadataTag[])).toEqual([undefined]);
		expect(Quality.fromMetaTags(["NOT_A_TAG", "MQA"] as unknown as redux.MediaMetadataTag[])).toEqual([undefined, Quality.MQA]);
	});
});

describe("fromAudioQuality", () => {
	test("undefined means no quality", () => {
		expect(Quality.fromAudioQuality()).toBeUndefined();
		expect(Quality.fromAudioQuality(undefined)).toBeUndefined();
	});

	test.each([
		["HI_RES_LOSSLESS", Quality.HiRes],
		["HI_RES", Quality.MQA],
		["LOSSLESS", Quality.High],
		["HIGH", Quality.Low],
		["LOW", Quality.Lowest],
	] as const)("maps %s to the matching quality", (audioQuality, quality) => {
		expect(Quality.fromAudioQuality(audioQuality)).toBe(quality);
	});
});

describe("valueOf", () => {
	test("is the rank of the quality", () => {
		expect(Quality.HiRes.valueOf()).toBe(6);
		expect(Quality.MQA.valueOf()).toBe(5);
		expect(Quality.Atmos.valueOf()).toBe(4);
		expect(Quality.Sony630.valueOf()).toBe(3);
		expect(Quality.High.valueOf()).toBe(2);
		expect(Quality.Low.valueOf()).toBe(1);
		expect(Quality.Lowest.valueOf()).toBe(0);
	});

	test("Max is the highest quality", () => {
		expect(Quality.Max).toBe(Quality.HiRes);
	});
});

describe("min/max", () => {
	test("return the lowest and highest of their arguments", () => {
		expect(Quality.min(Quality.HiRes, Quality.High)).toBe(Quality.High);
		expect(Quality.max(Quality.High, Quality.Low)).toBe(Quality.High);
		expect(Quality.min(Quality.MQA, Quality.Atmos)).toBe(Quality.Atmos);
		expect(Quality.max(Quality.MQA, Quality.Atmos)).toBe(Quality.MQA);
	});

	test("return the extreme quality of every rank", () => {
		const all = [Quality.Lowest, Quality.Low, Quality.High, Quality.Sony630, Quality.Atmos, Quality.MQA, Quality.HiRes] as const;
		expect(Quality.min(...all)).toBe(Quality.Lowest);
		expect(Quality.max(...all)).toBe(Quality.HiRes);
	});

	test("compare through valueOf, not identity", () => {
		// Nothing here is one of the statics, only their ranks are
		expect(Quality.max(fabricated(4))).toBe(Quality.Atmos);
		expect(Quality.min(Quality.HiRes, fabricated(1))).toBe(Quality.Low);
		expect(Quality.max(fabricated(2), fabricated(1))).toBe(Quality.High);
	});

	test("fall back to Lowest for a rank that is not a quality", () => {
		expect(Quality.max(fabricated(99))).toBe(Quality.Lowest);
		expect(Quality.min(fabricated(-1))).toBe(Quality.Lowest);
	});
});

describe("min/max with undefined entries", () => {
	const unknownTags = (...tags: string[]) => Quality.fromMetaTags(tags as unknown as redux.MediaMetadataTag[]);

	test("ignore undefined entries mixed with defined ones", () => {
		expect(Quality.max(undefined, Quality.High)).toBe(Quality.High);
		expect(Quality.max(Quality.High, undefined, Quality.Low)).toBe(Quality.High);
		expect(Quality.min(undefined, Quality.High)).toBe(Quality.High);
		expect(Quality.min(Quality.MQA, undefined, Quality.Atmos)).toBe(Quality.Atmos);
	});

	test("ignore the entry an unknown tag leaves in fromMetaTags", () => {
		expect(Quality.max(...unknownTags("NOT_A_TAG", "MQA"))).toBe(Quality.MQA);
		expect(Quality.min(...unknownTags("NOT_A_TAG", "MQA"))).toBe(Quality.MQA);
		expect(Quality.max(...unknownTags("LOSSLESS", "NOT_A_TAG", "HIRES_LOSSLESS"))).toBe(Quality.HiRes);
		expect(Quality.min(...unknownTags("LOSSLESS", "NOT_A_TAG", "HIRES_LOSSLESS"))).toBe(Quality.High);
	});

	test("are Lowest when nothing is left to compare, as for no arguments", () => {
		expect(Quality.max()).toBe(Quality.Lowest);
		expect(Quality.min()).toBe(Quality.Lowest);
		expect(Quality.max(undefined)).toBe(Quality.Lowest);
		expect(Quality.min(undefined, undefined)).toBe(Quality.Lowest);
		expect(Quality.max(...unknownTags("NOT_A_TAG"))).toBe(Quality.Lowest);
		expect(Quality.min(...unknownTags("NOT_A_TAG"))).toBe(Quality.Lowest);
	});
});

describe("getters", () => {
	test.each([
		["HiRes", Quality.HiRes, "HI_RES_LOSSLESS"],
		["MQA", Quality.MQA, "HI_RES"],
		["High", Quality.High, "LOSSLESS"],
		["Low", Quality.Low, "HIGH"],
		["Lowest", Quality.Lowest, "LOW"],
	] as const)("%s.audioQuality converts back to its source", (_, quality, audioQuality) => {
		expect(quality.audioQuality).toBe(audioQuality);
		expect(Quality.fromAudioQuality(quality.audioQuality)).toBe(quality);
	});

	test.each([
		["HiRes", Quality.HiRes, "HIRES_LOSSLESS"],
		["MQA", Quality.MQA, "MQA"],
		["Atmos", Quality.Atmos, "DOLBY_ATMOS"],
		["Sony630", Quality.Sony630, "SONY_360RA"],
		["High", Quality.High, "LOSSLESS"],
	] as const)("%s.metadataTag converts back to its source", (_, quality, metadataTag) => {
		expect(quality.metadataTag).toBe(metadataTag);
		expect(Quality.fromMetaTags([quality.metadataTag])).toEqual([quality]);
	});

	test("a quality TIDAL has no field for converts to undefined", () => {
		// TIDAL's audioQuality enum has no atmos/sony value and its metadataTags have no low value
		expect(Quality.Atmos.audioQuality).toBeUndefined();
		expect(Quality.Sony630.audioQuality).toBeUndefined();
		expect(Quality.Low.metadataTag).toBeUndefined();
		expect(Quality.Lowest.metadataTag).toBeUndefined();
	});
});
