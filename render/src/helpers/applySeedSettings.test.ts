import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { setIpcHandler } from "../../../test/setup-node";
import { ReactiveStore } from "../ReactiveStore";
import { applySeedSettings } from "./applySeedSettings";

/**
 * `applySeedSettings` applies the declarative luna-settings.json that nix.home-manager writes: values into
 * ReactiveStores and the set of plugins to keep. It reads the seed over ipc (main process finds the file) and reaches
 * the plugin storage through `LunaPlugin`, whose module boots TIDAL (`render/src/LunaPlugin.ts`), so it is mocked with
 * the statics this file uses. Its own stores are the real ReactiveStore on fake-indexeddb.
 *
 * What is installed lives in Luna core (`__LunaCore`, main process), which is faked here from the same `storage` map the
 * page's copy is kept in: an installed entry with a url is a plugin core lists, and `uninstall` removes it.
 *
 * `../modules` is mocked because the trace helpers dispatch a TIDAL message through it on every error.
 */
const stubs = vi.hoisted(() => {
	const storage = new Map<string, any>();
	/** Plugins `LunaPlugin.fromStorage` hands back, so a test can see whether `install()` ran */
	const created: { url: string; package?: unknown; installed: boolean; install: ReturnType<typeof vi.fn> }[] = [];
	return {
		storage,
		created,
		plugins: {} as Record<string, { installed?: boolean; url?: string }>,
		corePlugins: new Set<string>(),
		pluginStorage: { keys: vi.fn(), get: vi.fn(), del: vi.fn() },
		migrateToCore: vi.fn(async () => {}),
		core: { list: vi.fn(), uninstall: vi.fn() },
		fromStorage: vi.fn(async ({ url, package: pkg }: { url: string; package?: unknown }) => {
			const plugin = { url, package: pkg, installed: false, install: vi.fn(async () => {}) };
			created.push(plugin);
			return plugin;
		}),
		storePluginUrl: vi.fn((storeUrl: string, file: string) => `${storeUrl}/${file}`),
		fetchPackage: vi.fn(async (_url: string) => ({}) as { name?: string }),
		json: vi.fn(async (_url: string): Promise<{ plugins?: unknown }> => ({ plugins: [] })),
	};
});

vi.mock("../LunaPlugin", () => ({
	LunaPlugin: {
		pluginStorage: stubs.pluginStorage,
		migrateToCore: stubs.migrateToCore,
		corePlugins: stubs.corePlugins,
		plugins: stubs.plugins,
		fromStorage: stubs.fromStorage,
		storePluginUrl: stubs.storePluginUrl,
		fetchPackage: stubs.fetchPackage,
	},
}));
vi.mock("./fetch", () => ({ json: stubs.json }));
// The user is in TIDAL: waiting for the focus is tested with userInTidal itself
vi.mock("./userInTidal", () => ({ userInTidal: async () => {} }));
vi.mock("../modules", () => ({ reduxStore: { dispatch: vi.fn() } }));

const userStore = ReactiveStore.getStore("@luna/storage");
const pluginStores = ReactiveStore.getStore("@luna/pluginStores");
const seedStore = ReactiveStore.getStore("@luna/seedSettings");

const SOURCE = "[@luna/core].applySeedSettings";
/** luna-settings.json as the main process hands it over, untyped: every case decides what it holds */
const seed = (value: unknown) => setIpcHandler("__Luna.getSeedSettings", () => value);
/** The stores applySeedSettings installs from, as the user's TIDAL would have them */
const storeUrls = (...urls: string[]) => pluginStores.set("storeUrls", urls);
const storedPlugins = () => [...stubs.storage.keys()];
/** The ids it missed are remembered for the next start, under this key */
const notFound = () => seedStore.get<string>("notFound");

/** A stored plugin entry: `installed` tells removeUndeclaredPlugins whether an id still has to be installed */
const pluginEntry = (options: { installed?: boolean; url?: string } = {}) => ({
	enabled: true,
	installed: options.installed ?? true,
	url: options.url,
});

/**
 * The trace helpers capture `console.log`/`console.error` when their module is created, so a spy only sees what a
 * later generation of the module logs. These cases import one after installing their spy.
 */
const freshApply = async (): Promise<typeof applySeedSettings> => {
	vi.resetModules();
	return (await import("./applySeedSettings")).applySeedSettings;
};

beforeEach(async () => {
	stubs.storage.clear();
	stubs.created.length = 0;
	for (const name of Object.keys(stubs.plugins)) delete stubs.plugins[name];
	stubs.corePlugins.clear();
	stubs.corePlugins.add("@luna/lib");
	vi.clearAllMocks();
	stubs.pluginStorage.keys.mockImplementation(async () => [...stubs.storage.keys()]);
	stubs.pluginStorage.get.mockImplementation(async (key: string) => stubs.storage.get(key));
	stubs.pluginStorage.del.mockImplementation(async (key: string) => void stubs.storage.delete(key));
	stubs.core.list.mockImplementation(async () =>
		[...stubs.storage]
			.filter(([, entry]) => entry.installed && entry.url)
			.map(([name, entry]) => ({ url: entry.url, name, enabled: entry.enabled })),
	);
	stubs.core.uninstall.mockImplementation(async (url: string) => {
		for (const [name, entry] of stubs.storage) if (entry.url === url) stubs.storage.delete(name);
	});
	(globalThis as any).__LunaCore = stubs.core;
	stubs.json.mockReset();
	stubs.json.mockResolvedValue({ plugins: [] });
	stubs.fetchPackage.mockReset();
	stubs.fetchPackage.mockResolvedValue({ name: "unknown-package" });
	stubs.storePluginUrl.mockReset();
	stubs.storePluginUrl.mockImplementation((storeUrl: string, file: string) => `${storeUrl}/${file}`);
	await userStore.clear();
	await pluginStores.clear();
	await pluginStores.set("storeUrls", []);
	await seedStore.clear();
	seed(null);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("reading the seed", () => {
	test("does nothing when there is no luna-settings.json", async () => {
		stubs.storage.set("Keep", pluginEntry());

		await applySeedSettings();

		expect(storedPlugins()).toEqual(["Keep"]);
		expect(stubs.fromStorage).not.toHaveBeenCalled();
	});

	test.each([
		["null", null],
		["a string", "luna-settings"],
		["a number", 7],
		["an array", [{ plugins: [] }]],
	])("ignores %s", async (_label, value) => {
		stubs.storage.set("Keep", pluginEntry());
		seed(value);

		await applySeedSettings();

		expect(storedPlugins()).toEqual(["Keep"]);
		expect(stubs.fromStorage).not.toHaveBeenCalled();
	});

	test("logs that it is applying a seed", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		seed({});

		await (
			await freshApply()
		)();

		expect(log).toHaveBeenCalledWith(SOURCE, "Applying luna-settings.json");
	});

	test("logs and carries on when the seed cannot be read", async () => {
		const error = new Error("ipc down");
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		setIpcHandler("__Luna.getSeedSettings", () => {
			throw error;
		});

		await expect((await freshApply())()).resolves.toBeUndefined();

		expect(err).toHaveBeenCalledWith(SOURCE, "Failed to read luna-settings.json", error);
	});
});

describe("storage", () => {
	test("merges a declared object over the stored one, keeping the keys it does not declare", async () => {
		await userStore.set("luna", { autoUpdate: true, theme: "dark", nested: { a: 1 } });

		seed({ storage: { "@luna/storage": { luna: { theme: "light", nested: { b: 2 } } } } });
		await applySeedSettings();

		// The merge is one level deep, as devtools shows the values
		expect(await userStore.get("luna")).toEqual({ autoUpdate: true, theme: "light", nested: { b: 2 } });
	});

	test("replaces a stored value when the seed's value is not a plain object", async () => {
		await userStore.set("flag", 1);
		await userStore.set("list", [1, 2]);
		await userStore.set("object", { a: 1 });

		seed({ storage: { "@luna/storage": { flag: false, list: [3], object: null } } });
		await applySeedSettings();

		expect(await userStore.dump()).toEqual({ flag: false, list: [3], object: null });
	});

	test("replaces a stored value the seed's object cannot be merged into", async () => {
		await userStore.set("value", "plain");
		await userStore.set("list", [1]);

		seed({ storage: { "@luna/storage": { value: { a: 1 }, list: { a: 1 } } } });
		await applySeedSettings();

		expect(await userStore.dump()).toEqual({ value: { a: 1 }, list: { a: 1 } });
	});

	test("writes a key the store did not have yet", async () => {
		seed({ storage: { "@luna/storage": { fresh: { enabled: true } } } });

		await applySeedSettings();

		expect(await userStore.get("fresh")).toEqual({ enabled: true });
	});

	test("leaves stores and keys it does not declare alone", async () => {
		await userStore.set("untouched", { a: 1 });
		await pluginStores.set("other", 1);

		seed({ storage: { "@luna/storage": { written: 2 } } });
		await applySeedSettings();

		expect(await userStore.dump()).toEqual({ untouched: { a: 1 }, written: 2 });
		expect(await pluginStores.get("other")).toBe(1);
	});

	test("skips a store declaration that is not an object", async () => {
		seed({ storage: { "@luna/storage": "nope", "@luna/missing": 1 } });

		await applySeedSettings();

		expect(await userStore.dump()).toEqual({});
	});

	test("does not read the plugin storage for a seed without a plugin list", async () => {
		seed({ storage: { "@luna/storage": { written: 1 } } });

		await applySeedSettings();

		expect(stubs.pluginStorage.keys).not.toHaveBeenCalled();
	});
});

describe("plugins", () => {
	test("removes every stored plugin that is not declared, keeping the core ones", async () => {
		stubs.storage.set("@luna/lib", pluginEntry());
		stubs.storage.set("@luna/ui", pluginEntry());
		stubs.storage.set("third-party", pluginEntry({ url: "https://store.example/luna.third-party" }));
		stubs.corePlugins.add("@luna/ui");

		seed({ plugins: [] });
		await applySeedSettings();

		expect(storedPlugins()).toEqual(["@luna/lib", "@luna/ui"]);
	});

	test("hands the page's plugins to Luna core first, and removes one that is only named like a core plugin", async () => {
		stubs.storage.set("@luna/ui", pluginEntry({ url: "https://store.example/lookalike" }));
		stubs.corePlugins.add("@luna/ui");

		seed({ plugins: [] });
		await applySeedSettings();

		expect(stubs.migrateToCore).toHaveBeenCalledTimes(1);
		expect(stubs.migrateToCore.mock.invocationCallOrder[0]).toBeLessThan(stubs.core.list.mock.invocationCallOrder[0]!);
		expect(stubs.core.uninstall).toHaveBeenCalledWith("https://store.example/lookalike");
		expect(storedPlugins()).toEqual([]);
	});

	test("keeps a declared plugin, matched ignoring case", async () => {
		stubs.storage.set("DiscordRPC", pluginEntry({ url: "https://store.example/luna.DiscordRPC" }));

		seed({ plugins: ["discordrpc"] });
		await applySeedSettings();

		expect(storedPlugins()).toEqual(["DiscordRPC"]);
		// It is installed already, so nothing is fetched
		expect(stubs.fromStorage).not.toHaveBeenCalled();
	});

	test("matches a declared plugin by the file name its url ends in", async () => {
		stubs.storage.set("@scope/pretty-name", pluginEntry({ url: "https://store.example/luna.plugin-name" }));

		seed({ plugins: ["luna.plugin-name"] });
		await applySeedSettings();

		expect(storedPlugins()).toEqual(["@scope/pretty-name"]);
		expect(stubs.fromStorage).not.toHaveBeenCalled();
	});

	test("installs a declared plugin that is stored but not installed, from the store that lists it", async () => {
		stubs.storage.set("my-plugin", pluginEntry({ installed: false, url: "https://store.example/luna.my-plugin" }));
		await storeUrls("https://store.example");
		stubs.json.mockResolvedValue({ plugins: ["my-plugin.mjs"] });

		seed({ plugins: ["my-plugin"] });
		await applySeedSettings();

		await vi.waitFor(() => expect(stubs.created).toHaveLength(1));
		expect(stubs.fromStorage).toHaveBeenCalledWith({ url: "https://store.example/my-plugin", package: undefined });
		expect(stubs.created[0]!.install).toHaveBeenCalledTimes(1);
		expect(await notFound()).toBeUndefined();
	});

	test("finds a declared plugin by the package name in its package.json", async () => {
		await storeUrls("https://store.example");
		stubs.json.mockResolvedValue({ plugins: ["some-folder.mjs"] });
		stubs.fetchPackage.mockResolvedValue({ name: "@scope/My-Plugin" });

		seed({ plugins: ["@scope/my-plugin"] });
		await applySeedSettings();

		await vi.waitFor(() => expect(stubs.fromStorage).toHaveBeenCalled());
		expect(stubs.fetchPackage).toHaveBeenCalledWith("https://store.example/some-folder");
		expect(stubs.fromStorage).toHaveBeenCalledWith({
			url: "https://store.example/some-folder",
			package: { name: "@scope/My-Plugin" },
		});
	});

	test("does not fetch the package.json of an entry whose plugin is installed", async () => {
		await storeUrls("https://store.example");
		stubs.json.mockResolvedValue({ plugins: ["some-folder.mjs"] });
		stubs.plugins["installed"] = { installed: true, url: "https://store.example/some-folder" };

		seed({ plugins: ["missing-plugin"] });
		await applySeedSettings();

		await vi.waitFor(async () => expect(await notFound()).toBeDefined());
		expect(stubs.fetchPackage).not.toHaveBeenCalled();
	});

	test("keeps installing from the stores that answered when one is down", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		await storeUrls("https://down.example", "https://store.example");
		stubs.json.mockImplementation(async (url: string) => {
			if (url.startsWith("https://down.example")) throw new Error("offline");
			return { plugins: ["other-plugin.mjs"] };
		});
		stubs.fetchPackage.mockResolvedValue({ name: "wanted-plugin" });

		seed({ plugins: ["wanted-plugin"] });
		await applySeedSettings();

		await vi.waitFor(() => expect(stubs.fromStorage).toHaveBeenCalled());
	});

	test("logs and carries on when the plugin storage cannot be read", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		stubs.pluginStorage.keys.mockImplementation(async () => {
			throw new Error("indexeddb gone");
		});

		seed({ plugins: ["my-plugin"] });
		await expect((await freshApply())()).resolves.toBeUndefined();

		expect(err.mock.calls.flat()).toContain("Failed to apply luna-settings.json");
	});
});

describe("the notFound cache", () => {
	test("remembers the ids no store had, so the next start skips the package.json fetches", async () => {
		await storeUrls("https://store.example");
		stubs.json.mockResolvedValue({ plugins: ["known.mjs"] });

		seed({ plugins: ["ghost"] });
		await applySeedSettings();

		await vi.waitFor(async () => expect(await notFound()).toBeDefined());
		expect(JSON.parse((await notFound())!)).toEqual({
			ids: ["ghost"],
			entries: ["https://store.example/known"],
			failedStores: [],
		});
		expect(stubs.fetchPackage).toHaveBeenCalledTimes(1);

		// Nothing changed since: the same ids against the same store entries are not looked for again
		vi.clearAllMocks();
		seed({ plugins: ["ghost"] });
		await applySeedSettings();

		expect(stubs.fetchPackage).not.toHaveBeenCalled();
		expect(await notFound()).toBeDefined();
	});

	test("does not count a start with a store down for the next one", async () => {
		await storeUrls("https://down.example");
		stubs.json.mockRejectedValue(new Error("offline"));
		const err = vi.spyOn(console, "error").mockImplementation(() => {});

		seed({ plugins: ["ghost"] });
		await applySeedSettings();
		await vi.waitFor(async () => expect(await notFound()).toBeDefined());
		const downKey = await notFound();
		expect(JSON.parse(downKey!).failedStores).toEqual(["https://down.example"]);

		// The store answers this time: the key differs, so the packages are fetched again
		vi.clearAllMocks();
		stubs.json.mockResolvedValue({ plugins: ["ghost.mjs"] });
		seed({ plugins: ["ghost"] });
		await applySeedSettings();

		await vi.waitFor(() => expect(stubs.fromStorage).toHaveBeenCalled());
		expect(await notFound()).toBeUndefined();
		err.mockRestore();
	});

	test("forgets the missed ids once they are all installed", async () => {
		await seedStore.set("notFound", '{"ids":["my-plugin"]}');
		await storeUrls("https://store.example");
		stubs.json.mockResolvedValue({ plugins: ["my-plugin.mjs"] });

		seed({ plugins: ["my-plugin"] });
		await applySeedSettings();

		await vi.waitFor(async () => expect(await notFound()).toBeUndefined());
	});
});
