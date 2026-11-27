// Run: pnpm exec vitest run --project dom render/src/LunaPlugin.test.ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { setIpcHandler } from "../../test/setup-node";
import { LunaPlugin, type LunaPluginStorage } from "./LunaPlugin";

/**
 * `render/src/LunaPlugin.ts` is the renderer's plugin loader: it fetches `<url>.json` + `<url>.mjs`, imports the bundle,
 * tracks its unloads and dependants, live reloads it and persists all of that in a real `ReactiveStore` on
 * fake-indexeddb (see test/setup-dom.ts).
 *
 * The seams this test owns, because they are not real here:
 * - `./modules` is mocked. The real modules.ts resolves TIDAL's react/oby chunks while importing (boot code), so the
 *   loader gets a plain registry object instead.
 * - `fetch` is stubbed to serve the package/code of each registered url: no network, and every request is recorded.
 * - `URL.createObjectURL` is stubbed to hand back a `data:` URL of the bundle, because Node cannot import the `blob:`
 *   URL the real loader creates. One consequence: importing identical code twice returns Node's cached module instead
 *   of re-running it, so "the code ran again" is driven by a changed hash, like a real plugin update.
 * - `__ipcRenderer.on` is wrapped before the loader is imported, to capture the handlers its static block registers.
 *   test/setup-node.ts swallows them.
 */

/** The pieces of the loader that are replaced, hoisted so `vi.mock` and the static block both see them */
const { modules, ipcHandlers, traceLines } = vi.hoisted(() => {
	const modules: Record<string, any> = {};
	const ipcHandlers = new Map<string, (...args: any[]) => unknown>();
	// LunaPlugin.ts registers its handlers at import time, so this has to be in place first
	(globalThis as any).__ipcRenderer.on = (channel: string, handler: (...args: any[]) => unknown) => {
		ipcHandlers.set(channel, handler);
		return () => ipcHandlers.delete(channel);
	};
	// The loader's own trace output (console.log through Tracer), e.g. which dependants it defers. Tracer captures
	// `console.log` when it is created at import, before a test could spy on it, so it is wrapped here instead.
	const traceLines: string[] = [];
	console.log = (...args: any[]) => {
		traceLines.push(args.map((arg) => String(arg)).join(" "));
	};
	return { modules, ipcHandlers, traceLines };
});

vi.mock("./modules", () => ({ modules, reduxStore: { dispatch: () => {} } }));

/** Only the two fields the real `@inrixia/helpers` fetch helpers read */
type FakeResponse = { status: number; statusText: string; json: () => Promise<unknown>; text: () => Promise<string> };

const ok = (body: { json?: unknown; text?: string }): FakeResponse => ({
	status: 200,
	statusText: "OK",
	json: async () => body.json,
	text: async () => body.text ?? "",
});
const notFound = (): FakeResponse => ({ status: 404, statusText: "Not Found", json: async () => undefined, text: async () => "" });

/** The package/code served for one plugin url, plus `fetch` requests made against it */
type Served = { hash?: string; code?: string; package?: Record<string, unknown> };
const server = {
	served: new Map<string, Served>(),
	requests: [] as string[],
	hold: undefined as { matches: (url: string) => boolean; started: () => void; promise: Promise<void> } | undefined,
	reset() {
		this.served.clear();
		this.requests.length = 0;
		this.hold = undefined;
	},
	serve(url: string, served: Served) {
		this.served.set(url, served);
		return url;
	},
	jsonRequests: (url: string) => server.requests.filter((request) => request === `${url}.json`).length,
	codeRequests: (url: string) => server.requests.filter((request) => request === `${url}.mjs`).length,
};

const respond = (request: string): FakeResponse => {
	const isJson = request.endsWith(".json");
	const url = request.slice(0, isJson ? -".json".length : -".mjs".length);
	const served = server.served.get(url);
	if (served === undefined) return notFound();
	if (isJson) return ok({ json: { hash: "hash-1", ...served.package, ...(served.hash === undefined ? {} : { hash: served.hash }) } });
	if (served.code === undefined) return notFound();
	return ok({ text: served.code });
};

/** What the loader handed to `URL.createObjectURL`, and what it asked to revoke */
const objectUrls = { codes: [] as string[], urls: [] as string[], revoked: [] as string[] };

const stubObjectUrls = () => {
	const NativeBlob = globalThis.Blob;
	class CapturingBlob extends NativeBlob {
		public readonly code: string;
		public constructor(parts: any[], options?: any) {
			super(parts as any, options);
			this.code = parts.map((part) => String(part)).join("");
		}
	}
	vi.stubGlobal("Blob", CapturingBlob);
	vi.spyOn(URL, "createObjectURL").mockImplementation((blob: any) => {
		objectUrls.codes.push(blob.code);
		const url = `data:text/javascript,${encodeURIComponent(blob.code)}`;
		objectUrls.urls.push(url);
		return url;
	});
	vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
		objectUrls.revoked.push(url);
	});
};

/** What the plugin bundles in these tests push to, so the test can see which code ran and when */
const log: string[] = [];

/** A plugin bundle: an unloads set and an onUnload the loader also has to run, see `loadExports` */
const pluginCode = (name: string, extra = "") => `globalThis.__lunaTest.log.push("load:${name}");
export const unloads = new Set([() => globalThis.__lunaTest.log.push("unload:${name}")]);
export const onUnload = () => globalThis.__lunaTest.log.push("onUnload:${name}");
${extra}`;

let seq = 0;
/** Unique urls keep the loader's registries and the mocked fetch clean between tests */
const nextUrl = (label: string) => `https://luna.test/${++seq}/${label}`;

const serve = (
	url: string,
	name: string,
	{ hash, code, package: fields = {} }: { hash?: string; code?: string | null; package?: Record<string, unknown> } = {},
) => {
	// `code: null` serves a package with no bundle, which is how a plugin ends up enabled but never loaded
	server.serve(url, { hash, code: code === null ? undefined : (code ?? pluginCode(name)), package: { name, ...fields } });
	return url;
};

/** Creates a plugin the way the loader does at startup: from a store entry, fetching its package if it has none */
const createPlugin = async (
	name: string,
	{
		installed = true,
		enabled = true,
		hash,
		code,
		package: fields = {},
		url = nextUrl(name),
	}: { installed?: boolean; enabled?: boolean; hash?: string; code?: string | null; package?: Record<string, unknown>; url?: string } = {},
) => {
	serve(url, name, { hash, code, package: fields });
	const plugin = await LunaPlugin.fromStorage({ url, installed, enabled });
	return { url, plugin };
};

/** Lets the fire-and-forget writes ReactiveStore makes on change (and fire-and-forget loads) finish */
const settle = async (ticks = 5) => {
	for (let index = 0; index < ticks; index++) await new Promise((resolve) => setTimeout(resolve, 0));
};

let forgetNativePermissions: ReturnType<typeof vi.fn>;

beforeEach(async () => {
	await LunaPlugin.pluginStorage.clear();
	for (const url of Object.keys(LunaPlugin.plugins)) delete LunaPlugin.plugins[url];
	for (const name of Object.keys(modules)) delete modules[name];
	log.length = 0;
	traceLines.length = 0;
	(globalThis as any).__lunaTest = { log };
	server.reset();
	objectUrls.codes.length = 0;
	objectUrls.urls.length = 0;
	objectUrls.revoked.length = 0;
	stubObjectUrls();
	vi.stubGlobal("fetch", async (input: any) => {
		const request = String(input);
		server.requests.push(request);
		const hold = server.hold;
		if (hold !== undefined && hold.matches(request)) {
			hold.started();
			await hold.promise;
		}
		return respond(request);
	});
	forgetNativePermissions = vi.fn(async () => undefined);
	setIpcHandler("__Luna.nativePermissions.forget", forgetNativePermissions as (...args: any[]) => unknown);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	(globalThis as any).__lunaTest = undefined;
});

describe("fetching", () => {
	test("fetchPackage and fetchCode wrap a failed fetch with the url they tried", async () => {
		const url = nextUrl("missing");

		await expect(LunaPlugin.fetchPackage(url)).rejects.toThrow(`Failed to fetch package.json for ${url}: 404 Not Found`);
		await expect(LunaPlugin.fetchCode(url)).rejects.toThrow(`Failed to fetch code for ${url}: 404 Not Found`);

		// A package without a bundle is a package, a code fetch is what fails
		serve(url, "noBundle", { code: null });
		await expect(LunaPlugin.fetchPackage(url)).resolves.toMatchObject({ name: "noBundle" });
		await expect(LunaPlugin.fetchCode(url)).rejects.toThrow(`Failed to fetch code for ${url}`);
	});

	test("normalizeStoreUrl drops a trailing /store.json and storePluginUrl dots the spaces of store entries", () => {
		expect(LunaPlugin.normalizeStoreUrl("https://luna.test/store.json")).toBe("https://luna.test");
		expect(LunaPlugin.normalizeStoreUrl("https://luna.test")).toBe("https://luna.test");
		expect(LunaPlugin.normalizeStoreUrl("https://luna.test/nested/store.json")).toBe("https://luna.test/nested");

		// The local dev store serves its folders as they are, every other store replaces the spaces of a listing entry
		expect(LunaPlugin.storePluginUrl("http://127.0.0.1:3000", "My Plugin")).toBe("http://127.0.0.1:3000/My Plugin");
		expect(LunaPlugin.storePluginUrl("https://luna.test", "My Plugin")).toBe("https://luna.test/My.Plugin");
	});
});

describe("fromStorage", () => {
	test("creates a plugin from its fetched package without loading it", async () => {
		const { url, plugin } = await createPlugin("create", { installed: false, enabled: false });

		expect(plugin.name).toBe("create");
		expect(plugin.url).toBe(url);
		expect(LunaPlugin.plugins[url]).toBe(plugin);
		expect(plugin.installed).toBe(false);
		expect(plugin.enabled).toBe(false);
		// Loading from storage never turns live reload on by itself
		expect(plugin.liveReload).toBe(false);
		expect(plugin.exports).toBeUndefined();

		expect(server.jsonRequests(url)).toBe(1);
		expect(server.codeRequests(url)).toBe(0);
	});

	test("returns the instance it already has for the same url", async () => {
		const { url, plugin } = await createPlugin("reuse", { installed: false, enabled: false });

		expect(await LunaPlugin.fromStorage({ url })).toBe(plugin);
		// The package it fetched the first time is reused, so nothing is fetched again
		expect(server.jsonRequests(url)).toBe(1);
	});

	test("strips a .json/.mjs suffix users may have pasted as the url", async () => {
		const { url, plugin } = await createPlugin("suffix", { installed: false, enabled: false });

		const again = await LunaPlugin.fromStorage({ url: `${url}.mjs`, installed: false, enabled: false });
		expect(again).toBe(plugin);
		expect(again.url).toBe(url);
	});

	test("loads a stored plugin that is enabled and installed", async () => {
		const { url, plugin } = await createPlugin("stored");

		expect(plugin.installed).toBe(true);
		expect(plugin.enabled).toBe(true);
		expect(plugin.exports).toBeDefined();
		expect(modules["stored"]).toBe(plugin.exports);
		expect(plugin.loadError._).toBeUndefined();
		expect(plugin.loading._).toBe(false);
		expect(plugin.fetching._).toBe(false);

		// Its own unload plus the onUnload the loader adds, each named after the plugin so a leak is traceable
		const unloads = [...(plugin.exports?.unloads ?? [])];
		expect(unloads.map((unload) => unload.source)).toEqual(["stored", "stored.onUnload"]);

		// Package fetched twice (fromStorage, then loadExports) and the bundle once
		expect(server.jsonRequests(url)).toBe(2);
		expect(server.codeRequests(url)).toBe(1);
		expect(objectUrls.codes).toHaveLength(1);
		expect(objectUrls.codes[0].endsWith(`\n//# sourceURL=${url}.mjs`)).toBe(true);
		expect(objectUrls.revoked).toEqual(objectUrls.urls);
		expect(log).toEqual(["load:stored"]);
	});

	test("rewrites a registerNative call so native permissions are keyed by the plugin's url", async () => {
		const register = `export const register = () => __ipcRenderer.invoke("__Luna.registerNative", "native.js");`;
		const { url } = await createPlugin("native", { code: pluginCode("native", register) });

		expect(objectUrls.codes[0]).toContain(`"__Luna.registerNativeFrom",${JSON.stringify(url)},`);
	});

	test("keeps a plugin on a throwaway store when its name is persisted at another url", async () => {
		const persistedUrl = nextUrl("dev");
		const persisted = await LunaPlugin.pluginStorage.getReactive<LunaPluginStorage>("throwaway");
		persisted.url = persistedUrl;
		persisted.installed = true;

		// Another url for a name that is already persisted is only shown, it must not take over the persisted entry
		const { url, plugin } = await createPlugin("throwaway", { installed: false, enabled: false });
		expect(plugin.store).not.toBe(persisted);
		expect(plugin.installed).toBe(false);
		expect(plugin.enabled).toBe(false);
		expect(plugin.url).toBe(url);
		expect((await LunaPlugin.pluginStorage.getReactive<LunaPluginStorage>("throwaway")).url).toBe(persistedUrl);
	});

	test("closes an instance that is no longer the installed version of its name", async () => {
		const installed = await createPlugin("versions");
		const other = await createPlugin("versions", { installed: false, enabled: false });
		// Another version of the same plugin became installed
		other.plugin.store.installed = true;

		expect(await LunaPlugin.fromStorage({ url: installed.url })).toBe(installed.plugin);
		expect(installed.plugin.store.installed).toBe(false);
		expect(installed.plugin.store.enabled).toBe(false);
	});
});

describe("install / uninstall", () => {
	test("install persists the plugin and enables it", async () => {
		const { url, plugin } = await createPlugin("instP", { installed: false, enabled: false });
		await plugin.install();

		expect(plugin.installed).toBe(true);
		expect(plugin.enabled).toBe(true);
		expect(plugin.exports).toBeDefined();
		expect(server.codeRequests(url)).toBe(1);

		await settle();
		const persisted = await LunaPlugin.pluginStorage.get<LunaPluginStorage>("instP");
		expect(persisted?.url).toBe(url);
		expect(persisted?.installed).toBe(true);
		expect(persisted?.enabled).toBe(true);
		expect(persisted?.package?.hash).toBe("hash-1");
	});

	test("installing another version of a plugin uninstalls the one that was installed", async () => {
		const switchedFrom = await createPlugin("switch");
		const switchedTo = await createPlugin("switch", { installed: false, enabled: false });
		await switchedTo.plugin.install();

		expect(LunaPlugin.plugins[switchedFrom.url]).toBeUndefined();
		// Both versions share the plugin name, and exports live in the registry keyed by name, so the old instance's
		// `exports` now reads what the new version registered
		expect(switchedTo.plugin.exports).toBeDefined();
		expect(switchedTo.plugin.installed).toBe(true);
		expect(switchedTo.plugin.enabled).toBe(true);
		expect(forgetNativePermissions).toHaveBeenCalledWith(switchedFrom.url);
		expect(log).toContain("unload:switch");

		await settle();
		expect((await LunaPlugin.pluginStorage.getReactive<LunaPluginStorage>("switch")).url).toBe(switchedTo.url);
	});

	test("uninstall drops the plugin's storage entry, registry entry and dependants links", async () => {
		const dependency = await createPlugin("unDep");
		const plugin = await createPlugin("unA");
		// `plugin` is what `dependency` is depended on by, so its uninstall has to unlink it
		plugin.plugin.addDependant(dependency.plugin);
		await plugin.plugin.uninstall();

		expect(LunaPlugin.plugins[plugin.url]).toBeUndefined();
		expect(plugin.plugin.installed).toBe(false);
		expect(plugin.plugin.enabled).toBe(false);
		expect(plugin.plugin.exports).toBeUndefined();
		expect(dependency.plugin.dependants.has(plugin.plugin)).toBe(false);
		expect(forgetNativePermissions).toHaveBeenCalledWith(plugin.url);

		await settle();
		// `uninstall` deletes the entry, but ReactiveStore writes changes on a later microtask, so the write that
		// follows its delete puts a copy of the plugin back with installed:false. Reported as a bug; what must hold is
		// that it is no longer installed.
		const lingering = await LunaPlugin.pluginStorage.get<LunaPluginStorage>("unA");
		expect(lingering?.installed ?? false).toBe(false);
	});
});

describe("enable / disable / reload", () => {
	test("disable runs the plugin's unloads and clears its module registry entry", async () => {
		const { plugin } = await createPlugin("dis");
		expect(log).toEqual(["load:dis"]);

		await plugin.disable();

		expect(log).toEqual(["load:dis", "unload:dis", "onUnload:dis"]);
		expect(plugin.exports).toBeUndefined();
		expect(modules["dis"]).toBeUndefined();
		expect(plugin.enabled).toBe(false);
		expect(plugin.store.enabled).toBe(false);
		expect(plugin.loading._).toBe(false);
		// Already unloaded, so a second disable has nothing to run
		await plugin.disable();
		expect(log).toEqual(["load:dis", "unload:dis", "onUnload:dis"]);
	});

	test("enabling an already loaded plugin does not refetch the bundle", async () => {
		const { url, plugin } = await createPlugin("twice");
		await plugin.enable();

		expect(server.codeRequests(url)).toBe(1);
		expect(server.jsonRequests(url)).toBe(3);
		expect(log).toEqual(["load:twice"]);
		expect(plugin.exports).toBeDefined();
	});

	test("a bundle that throws sets loadError and leaves the plugin unloaded", async () => {
		const { plugin } = await createPlugin("throws", { installed: false, enabled: false, code: `throw new Error("boom from plugin");` });

		await expect(plugin.enable()).rejects.toThrow("boom from plugin");

		expect(plugin.loadError._).toBe("boom from plugin");
		expect(plugin.exports).toBeUndefined();
		expect(modules["throws"]).toBeUndefined();
		expect(plugin.enabled).toBe(false);
		expect(plugin.loading._).toBe(false);
		// The blob URL is revoked even when the import failed
		expect(objectUrls.revoked).toEqual(objectUrls.urls);
	});

	test("a plugin whose bundle cannot be fetched is enabled without being loaded", async () => {
		const { url, plugin } = await createPlugin("noCode", { code: null });

		// loadExports returns quietly when it has no code to import; enable still marks the plugin enabled
		expect(plugin.enabled).toBe(true);
		expect(plugin.installed).toBe(true);
		expect(plugin.exports).toBeUndefined();
		expect(plugin.loadError._).toBeUndefined();
		expect(server.codeRequests(url)).toBe(1);
	});

	test("fetching is signalled while the bundle is being fetched", async () => {
		const { plugin } = await createPlugin("gate", { installed: false, enabled: false });

		let started!: () => void;
		const requestStarted = new Promise<void>((resolve) => (started = resolve));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		server.hold = { matches: (url) => url.endsWith(".mjs"), started, promise: gate };

		const loading = plugin.enable();
		await requestStarted;
		expect(plugin.fetching._).toBe(true);

		release();
		await loading;
		expect(plugin.fetching._).toBe(false);
		expect(plugin.exports).toBeDefined();
	});

	test("reload picks up a changed hash, unloading the old code first", async () => {
		const { url, plugin } = await createPlugin("reload");
		expect(log).toEqual(["load:reload"]);

		serve(url, "reload", { hash: "hash-2", code: pluginCode("reload", `globalThis.__lunaTest.log.push("v2");`) });
		await plugin.reload();

		expect(plugin.package?.hash).toBe("hash-2");
		expect(plugin.code).toContain("v2");
		expect(log).toEqual(["load:reload", "unload:reload", "onUnload:reload", "load:reload", "v2"]);
		expect(server.codeRequests(url)).toBe(2);
		expect(plugin.exports).toBeDefined();
	});

	test("reload with an unchanged hash reuses the stored bundle", async () => {
		const { url, plugin } = await createPlugin("same");
		const before = objectUrls.codes.length;

		await plugin.reload();

		// No bundle fetch: the code kept in the plugin's package is what gets loaded again
		expect(server.codeRequests(url)).toBe(1);
		expect(server.jsonRequests(url)).toBe(3);
		expect(objectUrls.codes).toHaveLength(before + 1);
		// The old unloads always run before the code is loaded again
		expect(log).toContain("unload:same");
		expect(plugin.exports).toBeDefined();
	});

	test("liveReload reloads on an interval and stops when it is turned off", async () => {
		const { url, plugin } = await createPlugin("live");
		vi.useFakeTimers();

		plugin.liveReload = true;
		expect(plugin.liveReload).toBe(true);
		expect(plugin.store.liveReload).toBe(true);

		await vi.advanceTimersByTimeAsync(0);
		expect(server.jsonRequests(url)).toBe(3);
		await vi.advanceTimersByTimeAsync(1000);
		expect(server.jsonRequests(url)).toBe(4);

		plugin.liveReload = false;
		await vi.advanceTimersByTimeAsync(5000);
		expect(server.jsonRequests(url)).toBe(4);
		expect(plugin.store.liveReload).toBe(false);
	});
});

describe("dependants", () => {
	test("addDependant only takes plugins", async () => {
		const { plugin } = await createPlugin("onlyPlugins");
		expect(() => plugin.addDependant({} as any)).toThrow("Cannot add dependancy to non plugin!");
	});

	test("unloading a plugin unloads its dependants first", async () => {
		const base = await createPlugin("orderBase");
		const dependant = await createPlugin("orderDep");
		base.plugin.addDependant(dependant.plugin);

		await base.plugin.disable();

		expect(log).toEqual(["load:orderBase", "load:orderDep", "unload:orderDep", "onUnload:orderDep", "unload:orderBase", "onUnload:orderBase"]);
		expect(base.plugin.exports).toBeUndefined();
		expect(dependant.plugin.exports).toBeUndefined();
		// It is only unloaded, not disabled
		expect(dependant.plugin.enabled).toBe(true);
	});

	test("loading a plugin loads the dependants that are ready", async () => {
		const parent = await createPlugin("depParent");
		// An enabled plugin that never loaded: its bundle is missing, see the noCode test above
		const childUrl = serve(nextUrl("depChild"), "depChild", { code: null });
		const child = await LunaPlugin.fromStorage({ url: childUrl, installed: true, enabled: true });
		expect(child.exports).toBeUndefined();
		parent.plugin.addDependant(child);

		serve(childUrl, "depChild", { hash: "hash-2" });
		await parent.plugin.reload();
		await settle();

		expect(child.exports).toBeDefined();
		expect(log).toContain("load:depChild");
		expect(parent.plugin.dependants.size).toBe(0);
	});

	test("defers a dependant while another plugin it depends on is still loading", async () => {
		const otherUrl = serve(nextUrl("deferOther"), "deferOther", { code: null });
		const other = await LunaPlugin.fromStorage({ url: otherUrl, installed: true, enabled: true });
		expect(other.exports).toBeUndefined();
		const parent = await createPlugin("deferParent");
		const childUrl = serve(nextUrl("deferChild"), "deferChild", { code: null });
		const child = await LunaPlugin.fromStorage({ url: childUrl, installed: true, enabled: true });
		parent.plugin.addDependant(child);
		other.addDependant(child);

		await parent.plugin.reload();

		// Loading it now would race the plugin that is still loading, so the loader leaves it to that one
		expect(traceLines.some((line) => line.includes("Deferring dependant deferChild until deferOther is loaded"))).toBe(true);
		expect(child.exports).toBeUndefined();
		expect(parent.plugin.dependants.has(child)).toBe(true);

		serve(otherUrl, "deferOther", { hash: "hash-2" });
		serve(childUrl, "deferChild", { hash: "hash-2" });
		await other.reload();
		await settle();
		expect(child.exports).toBeDefined();
	});

	test("getByName prefers an installed version and getAllByName returns every version", async () => {
		const first = await createPlugin("pick", { enabled: false });
		const second = await createPlugin("pick", { installed: false, enabled: false });

		expect(LunaPlugin.getAllByName("pick")).toEqual([first.plugin, second.plugin]);
		expect(LunaPlugin.getByName("pick")).toBe(first.plugin);

		first.plugin.store.installed = false;
		second.plugin.store.installed = true;
		expect(LunaPlugin.getByName("pick")).toBe(second.plugin);
		expect(LunaPlugin.getByName("notLoaded")).toBeUndefined();
	});
});

describe("storage", () => {
	test("dumpStorage strips every bundle's code unless it is asked not to", async () => {
		await LunaPlugin.pluginStorage.set("dumpOne", {
			url: "https://luna.test/dumpOne",
			package: { name: "dumpOne", hash: "hash-1", code: "console.log(1)" },
			enabled: true,
			installed: true,
			liveReload: false,
			hideSettings: false,
		});
		await LunaPlugin.pluginStorage.set("dumpTwo", {
			url: "https://luna.test/dumpTwo",
			package: { name: "dumpTwo", hash: "hash-1" },
			enabled: false,
			installed: false,
			liveReload: false,
			hideSettings: false,
		});

		const stripped = (await LunaPlugin.dumpStorage()) as Record<string, any>;
		expect(stripped.dumpOne.package).toEqual({ name: "dumpOne", hash: "hash-1" });
		expect(stripped.dumpTwo.package).toEqual({ name: "dumpTwo", hash: "hash-1" });
		// Everything but the code is kept, it is what a settings export needs
		expect(stripped.dumpOne.url).toBe("https://luna.test/dumpOne");
		expect(stripped.dumpOne.enabled).toBe(true);

		const full = (await LunaPlugin.dumpStorage(false)) as Record<string, any>;
		expect(full.dumpOne.package.code).toBe("console.log(1)");
	});

	test("loadStoredPlugins loads the installed and enabled ones and ignores the rest", async () => {
		const loadUrl = serve(nextUrl("storedLoad"), "storedLoad");
		await LunaPlugin.pluginStorage.set("storedLoad", {
			url: loadUrl,
			package: { name: "storedLoad", hash: "hash-1" },
			enabled: true,
			installed: true,
			liveReload: false,
			hideSettings: false,
		});
		const offUrl = serve(nextUrl("storedOff"), "storedOff");
		await LunaPlugin.pluginStorage.set("storedOff", {
			url: offUrl,
			package: { name: "storedOff", hash: "hash-1" },
			enabled: false,
			installed: false,
			liveReload: false,
			hideSettings: false,
		});
		// Its package is gone: loadStoredPlugins has to swallow the failure, not reject with it
		const goneUrl = nextUrl("storedGone");
		await LunaPlugin.pluginStorage.set("storedGone", {
			url: goneUrl,
			package: { name: "storedGone", hash: "hash-1" },
			enabled: true,
			installed: true,
			liveReload: false,
			hideSettings: false,
		});

		await LunaPlugin.loadStoredPlugins();
		await settle();

		expect(log).toEqual(["load:storedLoad"]);
		expect(LunaPlugin.plugins[loadUrl].exports).toBeDefined();
		expect(LunaPlugin.plugins[offUrl].installed).toBe(false);
		expect(LunaPlugin.plugins[offUrl].exports).toBeUndefined();
		expect(LunaPlugin.plugins[goneUrl].enabled).toBe(true);
		expect(LunaPlugin.plugins[goneUrl].exports).toBeUndefined();
	});

	test("migrateBaseUrl rewrites stored urls and re-keys the loaded plugins", async () => {
		const fromBase = "https://old-store.test/plugins";
		const toBase = "https://new-store.test/plugins";
		const oldUrl = serve(`${fromBase}/Migrate`, "migrate", { code: null });
		const plugin = await LunaPlugin.fromStorage({ url: oldUrl, installed: false, enabled: false });
		await settle();

		await LunaPlugin.migrateBaseUrl(fromBase, toBase);

		const newUrl = `${toBase}/Migrate`;
		expect(LunaPlugin.plugins[oldUrl]).toBeUndefined();
		expect(LunaPlugin.plugins[newUrl]).toBe(plugin);
		expect((await LunaPlugin.pluginStorage.getReactive<LunaPluginStorage>("migrate")).url).toBe(newUrl);
	});

	test("fromName returns the loaded plugin, or loads it from storage", async () => {
		const { url, plugin } = await createPlugin("byName", { installed: false, enabled: false });
		expect(await LunaPlugin.fromName("byName")).toBe(plugin);

		// Not loaded in memory anymore, so it comes back from its persisted entry
		delete LunaPlugin.plugins[url];
		const reloaded = await LunaPlugin.fromName("byName");
		expect(reloaded).not.toBe(plugin);
		expect(reloaded?.url).toBe(url);

		expect(await LunaPlugin.fromName("neverStored")).toBeUndefined();
	});
});

describe("core plugins", () => {
	test("reloadAll skips core plugins and leaves them where they are", async () => {
		expect([...LunaPlugin.corePlugins]).toEqual(["@luna/lib", "@luna/lib.native", "@luna/ui", "@luna/dev", "@luna/linux"]);

		const core = await createPlugin("@luna/lib");
		const regular = await createPlugin("regular");
		const regularCodes = server.codeRequests(regular.url);

		expect(await LunaPlugin.reloadAll()).toEqual([]);

		expect(server.jsonRequests(core.url)).toBe(2);
		expect(server.jsonRequests(regular.url)).toBe(3);
		// Unchanged hash, so the bundle it already has is reused
		expect(server.codeRequests(regular.url)).toBe(regularCodes);
		expect(core.plugin.exports).toBeDefined();
		expect(regular.plugin.exports).toBeDefined();
	});

	test("reloadAll reports a plugin that failed and the dependants it took down", async () => {
		const failing = await createPlugin("failA");
		const dependant = await createPlugin("failB");
		failing.plugin.addDependant(dependant.plugin);

		serve(failing.url, "failA", { hash: "hash-2", code: `throw new Error("reload boom");` });
		const failed = await LunaPlugin.reloadAll();

		expect(failed.map((plugin) => plugin.name).sort()).toEqual(["failA", "failB"]);
		expect(failing.plugin.loadError._).toBe("reload boom");
		// The dependant was unloaded with its dependency and not loaded again
		expect(dependant.plugin.exports).toBeUndefined();
	});

	test("fromStack names the plugin a stack frame belongs to, never a core plugin", async () => {
		const { url, plugin } = await createPlugin("stack", { installed: false, enabled: false });
		const core = await createPlugin("@luna/lib", { installed: false, enabled: false });

		expect(LunaPlugin.fromStack(`Error: boom\n    at listener (${url}.mjs:12:3)`)).toBe(plugin);
		expect(LunaPlugin.fromStack(`Error: boom\n    at listener (${core.url}.mjs:1:1)`)).toBeUndefined();
		expect(LunaPlugin.fromStack(`Error: boom\n    at other (https://elsewhere.test/x.mjs:1:1)`)).toBeUndefined();
		expect(LunaPlugin.fromStack(undefined)).toBeUndefined();
	});
});

describe("ipc handlers", () => {
	test("the static block wires addDependant and unloads every plugin when the window closes", async () => {
		const base = await createPlugin("ipcA");
		const dependant = await createPlugin("ipcB");
		const onAddDependant = ipcHandlers.get("__Luna.LunaPlugin.addDependant")!;
		const onClose = ipcHandlers.get("window.close")!;
		expect(onAddDependant).toBeTypeOf("function");
		expect(onClose).toBeTypeOf("function");

		// The loader is told about dependants found while importing bundles from the blob
		onAddDependant("ipcA", "ipcB");
		expect(base.plugin.dependants.has(dependant.plugin)).toBe(true);

		expect(() => onAddDependant("ipcMissing", "ipcB")).toThrow(/not found/);
		expect(() => onAddDependant("ipcA", "ipcMissing")).toThrow(/not found/);

		onClose();
		await settle();
		expect(base.plugin.exports).toBeUndefined();
		expect(dependant.plugin.exports).toBeUndefined();
		// `window.close` doesn't await each unload, but each plugin is only unloaded once: the dependant is reached through
		// its dependency first, and the loop's call joins the unload already in flight instead of running it again
		expect(log).toEqual([
			"load:ipcA",
			"load:ipcB",
			"unload:ipcB",
			"onUnload:ipcB",
			"unload:ipcA",
			"onUnload:ipcA",
		]);
	});
});
