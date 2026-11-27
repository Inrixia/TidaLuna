import { beforeAll, describe, expect, it, vi } from "vitest";

import { Cache } from "@luna/core";

const native = vi.hoisted(() => ({
	cacheList: vi.fn(async () => [{ key: "offline" }, { key: "audio" }]),
	cacheStats: vi.fn(async (key: string) => ({ key, entries: 3 })),
	cacheSetLimit: vi.fn(async () => {}),
	cacheClear: vi.fn(async () => {}),
	cacheOpenLocation: vi.fn(async () => "C:/cache"),
}));
const listeners = vi.hoisted(() => new Map<string, (...args: any[]) => void>());
vi.mock("../../../lib.native/src/index.native", () => native);
vi.mock("../ipc", () => ({
	on: (_unloads: unknown, channel: string, listener: (...args: any[]) => void) => {
		listeners.set(channel, listener);
		return () => listeners.delete(channel);
	},
}));

const { NativeCache } = await import("./NativeCache");

describe("NativeCache", () => {
	beforeAll(() => NativeCache.loaded);

	it("adds a control keyed native:<key> for every main process cache", () => {
		expect([...Cache.controls.keys()].filter((key) => key.startsWith("native:")).sort()).toEqual(["native:audio", "native:offline"]);
	});

	it("adds a cache the main process makes later, once", () => {
		const added = vi.fn();
		const off = Cache.onControlAdded(new Set(), added);
		listeners.get("__Luna.cacheAdded")!("later");
		listeners.get("__Luna.cacheAdded")!("later");
		expect(added).toHaveBeenCalledTimes(1);
		expect(Cache.controls.has("native:later")).toBe(true);
		off();
	});

	it("gives stats keyed native:<key>", async () => {
		expect(await Cache.controls.get("native:offline")!.stats()).toMatchObject({ key: "native:offline", entries: 3 });
		expect(native.cacheStats).toHaveBeenCalledWith("offline");
	});

	it("passes only its own pushed stats to onStats, keyed native:<key>", () => {
		const seen = vi.fn();
		Cache.controls.get("native:offline")!.onStats(new Set(), seen);
		const push = listeners.get("__Luna.cacheStats")!;
		push({ key: "audio", entries: 1 });
		push({ key: "offline", entries: 2 });
		expect(seen).toHaveBeenCalledTimes(1);
		expect(seen).toHaveBeenCalledWith({ key: "native:offline", entries: 2 });
	});

	it("calls the main process for the limit, clear and openLocation by its native key", async () => {
		const control = Cache.controls.get("native:audio")!;
		await control.setUserBytesLimit(5);
		await control.clear();
		expect(await control.openLocation!()).toBe("C:/cache");
		expect(native.cacheSetLimit).toHaveBeenCalledWith("audio", 5);
		expect(native.cacheClear).toHaveBeenCalledWith("audio");
		expect(native.cacheOpenLocation).toHaveBeenCalledWith("audio");
	});
});
