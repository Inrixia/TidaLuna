import { describe, expect, it } from "vitest";

import { backendContract } from "test/backendContract";
import { MapBackend } from "./MapBackend";
import { readAll } from "./streams";
import { StreamBufferBackend } from "./StreamBufferBackend";

const bytes = (n: number) => new Uint8Array([n, n + 1, n + 2, n + 3]);

backendContract("MapBackend", { make: () => new MapBackend<{ n: number }>(), value: (n) => ({ n }) });
backendContract("StreamBufferBackend", { make: () => new StreamBufferBackend(), value: bytes });

describe("StreamBufferBackend", () => {
	it("is readable while the value streams in, and pinned while read", async () => {
		const backend = new StreamBufferBackend();
		let push!: ReadableStreamDefaultController<Uint8Array>;
		const source = new ReadableStream<Uint8Array>({ start: (controller) => void (push = controller) });
		const writing = backend.setStream("a", source);
		const reading = readAll(backend.getStream("a")!);
		expect(backend.pinned("a")).toBe(true);
		expect(backend.stats().inFlight).toEqual([{ key: "a", filledBytes: 0, readers: 1 }]);
		push.enqueue(bytes(1));
		push.enqueue(bytes(5));
		push.close();
		expect(await writing).toBe(8);
		expect(await reading).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
		expect(backend.pinned("a")).toBe(false);
		expect(backend.stats().inFlight).toEqual([]);
	});

	it("fails every reader with the source's error", async () => {
		const backend = new StreamBufferBackend();
		let push!: ReadableStreamDefaultController<Uint8Array>;
		const source = new ReadableStream<Uint8Array>({ start: (controller) => void (push = controller) });
		const writing = backend.setStream("a", source);
		const reading = readAll(backend.getStream("a")!);
		push.error(new Error("source failed"));
		await expect(writing).rejects.toThrow("source failed");
		await expect(reading).rejects.toThrow("source failed");
		expect(backend.get("a")).toBeUndefined();
	});

	it("sizes values by their bytes", () => {
		expect(new StreamBufferBackend().sizeOf(bytes(1))).toBe(4);
	});
});

describe("MapBackend", () => {
	it("sizes values by the memory they take", () => {
		const backend = new MapBackend<string>();
		expect(backend.sizeOf("abcd")).toBeGreaterThan(backend.sizeOf("a"));
	});
});
