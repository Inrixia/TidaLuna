// Run: pnpm exec vitest run native/worlds.test.ts

import { beforeEach, describe, expect, test, vi } from "vitest";

type Handler = (event: { sender: unknown }, ...args: unknown[]) => Promise<any>;
const handlers = new Map<string, Handler>();
const changeListeners: ((url: string) => void)[] = [];
/** url -> the accepted world text, as registry().acceptedWorld answers */
const accepted = new Map<string, string>();
const secureLoad = vi.fn();
let isolated = true;

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => null } }));
vi.mock("./ipc", () => ({ ipcHandle: (channel: string, listener: Handler) => void handlers.set(channel, listener) }));
vi.mock("./isolatedContents", () => ({ isIsolated: () => isolated }));
vi.mock("./NativeModule/secureLoad", () => ({ secureLoad: (...args: unknown[]) => secureLoad(...args) }));
vi.mock("./core/registryMain", () => ({
	registry: () => ({ acceptedWorld: (url: string) => accepted.get(url) }),
	onPluginChanged: (listener: (url: string) => void) => void changeListeners.push(listener),
}));

import { moduleOwners } from "./NativeModule/worldNatives";

const URL = "https://example.com/plugin";
const OTHER = "https://example.com/other";
const bundle = (natives: Record<string, string> = { "a.native.ts": "code a" }, code = "world code") => JSON.stringify({ code, natives });
const sender = {};
const load = (url: unknown = URL) => handlers.get("__LunaWorld.load")!({ sender }, url);
const invoke = (...args: unknown[]) => handlers.get("__LunaWorld.invoke")!({ sender }, ...args);
const changed = (url: string) => changeListeners.forEach((listener) => listener(url));

beforeEach(async () => {
	await import("./worlds");
	accepted.clear();
	moduleOwners.clear();
	isolated = true;
	secureLoad.mockReset();
	secureLoad.mockImplementation(async () => ({ hello: (name: string) => `hello ${name}` }));
	(globalThis as any).luna = { modules: {} };
});

describe("__LunaWorld.load", () => {
	test("refuses a page without contextIsolation", async () => {
		isolated = false;
		accepted.set(URL, bundle());
		await expect(load()).rejects.toThrow(/need contextIsolation/);
		expect(secureLoad).not.toHaveBeenCalled();
	});

	test("refuses anything that is not an http(s) url", async () => {
		await expect(load("file:///etc/passwd")).rejects.toThrow(/Not a plugin url/);
		await expect(load(42)).rejects.toThrow(/Not a plugin url/);
	});

	test("refuses a plugin that is not enabled with a world", async () => {
		await expect(load()).rejects.toThrow(/not an enabled plugin with a world/);
	});

	test("loads the accepted world: natives go through secureLoad under world: names, the world code is returned", async () => {
		accepted.set(URL, bundle());
		const result = await load();

		expect(result.code).toBe("world code");
		expect(typeof result.worldId).toBe("number");
		expect(secureLoad).toHaveBeenCalledTimes(1);
		expect(secureLoad.mock.calls[0][0]).toEqual(expect.objectContaining({ fileName: "world:a.native.ts", code: "code a", url: URL, isCore: false }));
		expect(globalThis.luna.modules["a.native.ts"]).toBeDefined();
		expect(moduleOwners.get("a.native.ts")).toBe(URL);
	});

	test("each load gets a new world id", async () => {
		accepted.set(URL, bundle());
		const first = await load();
		const second = await load();
		expect(second.worldId).toBeGreaterThan(first.worldId);
	});

	test("refuses a native module name Luna or another plugin has", async () => {
		accepted.set(URL, bundle());
		globalThis.luna.modules["a.native.ts"] = {};
		await expect(load()).rejects.toThrow(/already registered by Luna or another plugin/);
		delete globalThis.luna.modules["a.native.ts"];

		moduleOwners.set("a.native.ts", OTHER);
		await expect(load()).rejects.toThrow(/already registered by Luna or another plugin/);
		expect(secureLoad).not.toHaveBeenCalled();
	});

	test("a native refused by the user fails the load and frees what it reserved", async () => {
		accepted.set(URL, bundle());
		secureLoad.mockRejectedValue(new Error("denied"));
		await expect(load()).rejects.toThrow("denied");
		expect(globalThis.luna.modules["a.native.ts"]).toBeUndefined();
		expect(moduleOwners.has("a.native.ts")).toBe(false);
	});

	test("a plugin disabled while the user was asked fills nothing", async () => {
		accepted.set(URL, bundle());
		secureLoad.mockImplementation(async () => {
			accepted.delete(URL);
			changed(URL);
			return { hello: () => "x" };
		});
		await expect(load()).rejects.toThrow(/a newer load or a disable replaced this load/);
		expect(globalThis.luna.modules["a.native.ts"]).toBeUndefined();
		expect(moduleOwners.has("a.native.ts")).toBe(false);
	});

	test("a newer load of the same url wins over one still waiting", async () => {
		accepted.set(URL, bundle());
		let release!: () => void;
		secureLoad.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ hello: () => "old" }))));
		const older = load();
		await vi.waitFor(() => expect(secureLoad).toHaveBeenCalledTimes(1));

		secureLoad.mockImplementationOnce(async () => ({ hello: () => "new" }));
		await load();
		release();
		await expect(older).rejects.toThrow(/a newer load or a disable replaced this load/);
		expect(await invoke(URL, "a.native.ts", "hello")).toBe("new");
	});

	test("natives an earlier version had and this one dropped are no longer importable", async () => {
		accepted.set(URL, bundle({ "a.native.ts": "code a", "b.native.ts": "code b" }));
		await load();
		expect(globalThis.luna.modules["b.native.ts"]).toBeDefined();

		accepted.set(URL, bundle({ "a.native.ts": "code a" }));
		await load();
		expect(globalThis.luna.modules["b.native.ts"]).toBeUndefined();
		expect(moduleOwners.has("b.native.ts")).toBe(false);
		await expect(invoke(URL, "b.native.ts", "hello")).rejects.toThrow(/has no native file/);
	});

	test("a world that is not a bundle is refused", async () => {
		accepted.set(URL, JSON.stringify({ code: 1 }));
		await expect(load()).rejects.toThrow(/Not a world bundle/);
	});
});

describe("__LunaWorld.invoke", () => {
	test("calls an export of a loaded world native", async () => {
		accepted.set(URL, bundle());
		await load();
		expect(await invoke(URL, "a.native.ts", "hello", "luna")).toBe("hello luna");
	});

	test("refuses a url or file that never loaded", async () => {
		accepted.set(URL, bundle());
		await load();
		await expect(invoke(OTHER, "a.native.ts", "hello")).rejects.toThrow(/has no native file/);
		await expect(invoke(URL, "nope.ts", "hello")).rejects.toThrow(/has no native file/);
		await expect(invoke(undefined, undefined, "hello")).rejects.toThrow(/has no native file/);
	});

	test("refuses a page without contextIsolation", async () => {
		accepted.set(URL, bundle());
		await load();
		isolated = false;
		await expect(invoke(URL, "a.native.ts", "hello")).rejects.toThrow(/need contextIsolation/);
	});

	test("stops once the plugin is disabled or a different version is accepted", async () => {
		accepted.set(URL, bundle());
		await load();
		accepted.set(URL, bundle({ "a.native.ts": "code a" }, "newer world"));
		await expect(invoke(URL, "a.native.ts", "hello")).rejects.toThrow(/not enabled at the version its world loaded/);

		accepted.delete(URL);
		await expect(invoke(URL, "a.native.ts", "hello")).rejects.toThrow(/not enabled at the version its world loaded/);
	});

	test("a change that leaves the accepted world as it was keeps the natives", async () => {
		accepted.set(URL, bundle());
		await load();
		changed(URL);
		expect(await invoke(URL, "a.native.ts", "hello", "luna")).toBe("hello luna");
	});

	test("a change that disables the plugin removes its natives from luna.modules", async () => {
		accepted.set(URL, bundle());
		await load();
		accepted.delete(URL);
		changed(URL);
		expect(globalThis.luna.modules["a.native.ts"]).toBeUndefined();
		await expect(invoke(URL, "a.native.ts", "hello")).rejects.toThrow(/has no native file/);
	});

	test("only own exports that are functions can be called", async () => {
		accepted.set(URL, bundle());
		secureLoad.mockResolvedValue({ value: 1 });
		await load();
		await expect(invoke(URL, "a.native.ts", "value")).rejects.toThrow(/has no export value/);
		await expect(invoke(URL, "a.native.ts", "toString")).rejects.toThrow(/has no export toString/);
		await expect(invoke(URL, "a.native.ts", 5)).rejects.toThrow(/has no export 5/);
	});

	test("an error from the native gets the call named in its cause", async () => {
		accepted.set(URL, bundle());
		secureLoad.mockResolvedValue({
			fail: () => {
				throw new Error("boom");
			},
		});
		await load();
		const err = await invoke(URL, "a.native.ts", "fail").catch((e) => e);
		expect(err.message).toBe("boom");
		expect(err.cause).toBe("[Luna.worlds] (a.native.ts).fail");
	});
});
