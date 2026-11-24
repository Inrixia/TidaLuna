import { describe, expect, it } from "vitest";

import { readAll } from "../streams";
import { StreamBuffer } from "./StreamBuffer";
import { addRange, filledBytes, gapFrom } from "./StreamBuffer.ranges";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const settle = () => new Promise(setImmediate);

describe("StreamBuffer", () => {
	it("readers wait for bytes written later and in any order, asking for them where they wait", async () => {
		const waits: number[] = [];
		const buffer = new StreamBuffer({ onWait: (pos) => void waits.push(pos) });
		const reading = readAll(buffer.stream(2, 8));
		await settle();
		buffer.allocate(new Uint8Array(10));
		buffer.write(5, bytes("56789"));
		await settle();
		buffer.write(0, bytes("01234"));
		expect(text(await reading)).toBe("234567");
		expect(waits).toEqual([2, 2]);
		expect({ complete: buffer.complete, readers: buffer.readers }).toEqual({ complete: true, readers: 0 });
	});

	it("a cancelled reader stops waiting and releases the buffer", async () => {
		let released = 0;
		let waitingChanges = 0;
		const buffer = new StreamBuffer({ onRelease: () => released++, onWaitingChange: () => waitingChanges++ });
		buffer.allocate(new Uint8Array(4));
		const reader = buffer.stream(0, 4).getReader();
		const read = reader.read();
		await settle();
		expect(buffer.waiting).toBe(1);
		await reader.cancel();
		await read;
		await settle();
		expect({ waiting: buffer.waiting, readers: buffer.readers, released, waitingChanges }).toEqual({
			waiting: 0,
			readers: 0,
			released: 1,
			waitingChanges: 2,
		});
	});

	it("sizeFrom waits for the size, a failed wait ends the stream with its error", async () => {
		const buffer = new StreamBuffer({
			onWait: (pos) => {
				if (pos === 3) throw new Error("fetch failed");
			},
		});
		const size = buffer.sizeFrom(0, new AbortController().signal);
		buffer.allocate(new Uint8Array(6));
		expect(await size).toBe(6);
		await expect(readAll(buffer.stream(3, 6))).rejects.toThrow(/fetch failed/);
		expect(buffer.readers).toBe(0);
	});

	it("appended bytes reach readers as they arrive, the end of an unsized stream is where `end` is called", async () => {
		const buffer = new StreamBuffer();
		const all = readAll(buffer.stream());
		const tail = readAll(buffer.stream(3));
		buffer.append(bytes("012"));
		await settle();
		// Past the first allocation, so the buffer is copied larger while readers hold views of the old one
		const big = new Uint8Array(70 * 1024).fill(97);
		buffer.append(big);
		buffer.append(bytes("xyz"));
		buffer.end();
		const expected = "012" + "a".repeat(big.byteLength) + "xyz";
		expect(text(await all)).toBe(expected);
		expect(text(await tail)).toBe(expected.slice(3));
		expect({ size: buffer.size, complete: buffer.complete, readers: buffer.readers }).toEqual({
			size: expected.length,
			complete: true,
			readers: 0,
		});
		expect(text(buffer.bytes!)).toBe(expected);
	});

	it("a producer failure ends every reader, waiting or not", async () => {
		const buffer = new StreamBuffer();
		buffer.append(bytes("ab"));
		const first = readAll(buffer.stream());
		const second = readAll(buffer.stream(1));
		await settle();
		buffer.fail(new Error("source broke"));
		await expect(first).rejects.toThrow("source broke");
		await expect(second).rejects.toThrow("source broke");
		expect(buffer.readers).toBe(0);
	});

	it("a reader whose signal aborts ends with the abort and releases the buffer", async () => {
		const buffer = new StreamBuffer();
		const controller = new AbortController();
		const reading = readAll(buffer.stream(0, undefined, controller.signal));
		await settle();
		controller.abort(new Error("gone"));
		await expect(reading).rejects.toThrow("gone");
		expect(buffer.readers).toBe(0);
	});

	it("of gives a complete buffer over the bytes", async () => {
		const buffer = StreamBuffer.of(bytes("hello"));
		expect(buffer.complete).toBe(true);
		expect(text(await readAll(buffer.stream(1, 4)))).toBe("ell");
	});
});

describe("ranges", () => {
	it("merges touching ranges and finds gaps", () => {
		const ranges: [number, number][] = [];
		addRange(ranges, 5, 10);
		addRange(ranges, 0, 2);
		addRange(ranges, 2, 5);
		expect(ranges).toEqual([[0, 10]]);
		addRange(ranges, 20, 30);
		expect(gapFrom(ranges, 0, 40)).toEqual([10, 20]);
		expect(gapFrom(ranges, 25, 40)).toEqual([30, 40]);
		expect(gapFrom(ranges, 25, 30)).toBeUndefined();
		expect(filledBytes(ranges)).toBe(20);
	});
});
