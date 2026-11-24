import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { LunaUnload } from "@luna/core";

import { setIpcHandler } from "../../../test/setup-node";

import * as ipc from "./ipc";

/** Luna's preload installs `__ipcRenderer` as a global; `test/setup-node.ts` fakes it for the dom project too */
const ipcRenderer = () => (<{ __ipcRenderer: Record<string, (...args: any[]) => any> }>(<unknown>globalThis)).__ipcRenderer;

/** The preload's own listeners, restored so a test's fake doesn't leak into the next file's module state */
const realOn = ipcRenderer().on;
const realOnce = ipcRenderer().once;

let unloads: Set<LunaUnload>;

beforeEach(() => {
	unloads = new Set();
});

afterEach(() => {
	ipcRenderer().on = realOn;
	ipcRenderer().once = realOnce;
	vi.restoreAllMocks();
});

describe("re-exports", () => {
	test("invoke and send are the preload's", () => {
		expect(ipc.invoke).toBe(ipcRenderer().invoke);
		expect(ipc.send).toBe(ipcRenderer().send);
	});

	test("invoke calls the main process handler registered for the channel", async () => {
		setIpcHandler("__Luna.echo", (value: number) => value * 2);

		await expect(ipc.invoke("__Luna.echo", 21)).resolves.toBe(42);
		await expect(ipc.invoke("__Luna.unhandled")).resolves.toBeUndefined();
	});
});

describe("on", () => {
	test("subscribes the listener to the channel", () => {
		const unload = vi.fn();
		const on = vi.fn(() => unload);
		ipcRenderer().on = on;
		const listener = vi.fn();

		expect(ipc.on(unloads, "__Luna.someChannel", listener)).toBe(unload);
		expect(on).toHaveBeenCalledWith("__Luna.someChannel", listener);
	});

	test("adds the returned unload to unloads", () => {
		const unload = vi.fn();
		ipcRenderer().on = vi.fn(() => unload);

		ipc.on(unloads, "__Luna.someChannel", vi.fn());

		expect(unloads.has(unload)).toBe(true);
	});
});

describe("once", () => {
	test("subscribes the listener to the channel for one message", () => {
		const unload = vi.fn();
		const once = vi.fn(() => unload);
		ipcRenderer().once = once;
		const listener = vi.fn();

		expect(ipc.once(unloads, "__Luna.someChannel", listener)).toBe(unload);
		expect(once).toHaveBeenCalledWith("__Luna.someChannel", listener);
		expect(unloads.has(unload)).toBe(true);
	});
});

describe("onOpenUrl", () => {
	test("listens on __Luna.openUrl", () => {
		const unload = vi.fn();
		const on = vi.fn(() => unload);
		ipcRenderer().on = on;
		const listener = vi.fn();

		expect(ipc.onOpenUrl(unloads, listener)).toBe(unload);
		expect(on).toHaveBeenCalledWith("__Luna.openUrl", listener);
		expect(unloads.has(unload)).toBe(true);
	});
});
