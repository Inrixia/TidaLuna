import { describe, expect, test } from "vitest";

import { sanitizeData } from "./sanitizeData";

describe("sanitizeData", () => {
	test("no arguments gives undefined", () => {
		expect(sanitizeData()).toBeUndefined();
	});

	test("a single argument is stringified", () => {
		expect(sanitizeData("string")).toBe("string");
		expect(sanitizeData(42)).toBe("42");
		expect(sanitizeData(0)).toBe("0");
		expect(sanitizeData(-1.5)).toBe("-1.5");
		expect(sanitizeData(true)).toBe("true");
		expect(sanitizeData(false)).toBe("false");
		expect(sanitizeData(null)).toBe("null");
		expect(sanitizeData(undefined)).toBeUndefined();
		expect(sanitizeData(1n)).toBe("1");
	});

	test("an Error becomes its message", () => {
		expect(sanitizeData(new Error("boom"))).toBe("boom");
		expect(sanitizeData(new TypeError("bad type"))).toBe("bad type");
		expect(sanitizeData(new Error())).toBe("");
	});

	test("objects are serialized as JSON", () => {
		expect(sanitizeData({ a: 1, b: ["x"] })).toBe('{"a":1,"b":["x"]}');
		expect(sanitizeData([1, 2])).toBe("[1,2]");
		expect(sanitizeData({ nested: { ok: true } })).toBe('{"nested":{"ok":true}}');
	});

	test("objects JSON.stringify can't handle fall back to String", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(sanitizeData(circular)).toBe("[object Object]");
		// A BigInt inside the object throws in JSON.stringify
		expect(sanitizeData({ big: 1n })).toBe("[object Object]");
	});

	test("multiple arguments are joined with spaces", () => {
		expect(sanitizeData("a", 1, true, null)).toBe("a 1 true null");
		expect(sanitizeData("error:", new Error("boom"))).toBe("error: boom");
		expect(sanitizeData("obj", { a: 1 })).toBe('obj {"a":1}');
	});

	test("undefined entries in multiple arguments are joined as empty strings", () => {
		expect(sanitizeData(undefined, "b")).toBe(" b");
		expect(sanitizeData("a", undefined, "b")).toBe("a  b");
	});
});
