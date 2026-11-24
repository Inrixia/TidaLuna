import { describe, expect, test } from "vitest";

import { parseDate } from "./parseDate";

describe("parseDate", () => {
	test("returns undefined for missing input", () => {
		expect(parseDate(undefined)).toBeUndefined();
		expect(parseDate(null)).toBeUndefined();
	});

	test("parses an ISO string", () => {
		expect(parseDate("2024-03-05T06:07:08.000Z")).toEqual(new Date("2024-03-05T06:07:08.000Z"));
	});

	test("parses a date string TIDAL does not return in ISO form", () => {
		expect(parseDate("2024-03-05")).toEqual(new Date("2024-03-05"));
	});

	test("returns undefined for an unparseable string", () => {
		expect(parseDate("not a date")).toBeUndefined();
		expect(parseDate("")).toBeUndefined();
	});

	test("passes a valid Date through", () => {
		const date = new Date("2024-03-05T06:07:08.000Z");
		expect(parseDate(date)).toBe(date);
	});

	test("returns undefined for an invalid Date", () => {
		expect(parseDate(new Date(Number.NaN))).toBeUndefined();
	});
});
