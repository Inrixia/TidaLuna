import { beforeEach, describe, expect, test, vi } from "vitest";
import { ReactiveStore } from "./ReactiveStore";
import { SettingsTransfer, type ExportData } from "./SettingsTransfer";

/**
 * SettingsTransfer reaches the plugin storage through `LunaPlugin`, and render/src/LunaPlugin.ts loads boot code, so it
 * is mocked with the two statics SettingsTransfer uses: a plugin storage and `dumpStorage` (the real one strips each
 * plugin's `package.code`). The other two exportable stores are the real ReactiveStore on fake-indexeddb.
 *
 * What is installed lives in Luna core (`__LunaCore`, main process), faked with an in-memory list (`installedInCore`).
 * Its `install` answers from `installAnswers`, as the user would in the core's confirmation window.
 */
const { pluginStorage, pluginStorageData, dumpStorage, migrateToCore, core, installedInCore, installAnswers } = vi.hoisted(() => {
	const stripPackageCode = (value: unknown) => {
		const stripped = { ...(value as Record<string, any>) };
		if (stripped.package !== undefined) stripped.package = { ...stripped.package };
		delete stripped.package?.code;
		return stripped;
	};
	const pluginStorageData = new Map<string, any>();
	const installedInCore = new Map<string, { url: string; name: string; enabled: boolean }>();
	const installAnswers = new Map<string, boolean | Error>();
	const core = {
		list: vi.fn(async () => [...installedInCore.values()]),
		info: vi.fn(async (url: string) => installedInCore.get(url)),
		uninstall: vi.fn(async (url: string) => void installedInCore.delete(url)),
		disable: vi.fn(async (url: string) => {
			const entry = installedInCore.get(url);
			if (entry) entry.enabled = false;
		}),
		install: vi.fn(async (url: string) => {
			const answer = installAnswers.get(url) ?? true;
			if (answer instanceof Error) throw answer;
			if (answer) installedInCore.set(url, { url, name: url, enabled: true });
			return answer;
		}),
	};

	return {
		pluginStorageData,
		installedInCore,
		installAnswers,
		core,
		migrateToCore: vi.fn(async () => {}),
		pluginStorage: {
			idbName: "@luna/plugins",
			clear: async () => pluginStorageData.clear(),
			keys: async () => [...pluginStorageData.keys()],
			get: async (key: string) => pluginStorageData.get(key),
			set: async (key: string, value: unknown) => {
				pluginStorageData.set(key, value);
				return value;
			},
			dump: async () => Object.fromEntries(pluginStorageData),
		},
		dumpStorage: vi.fn(async (stripCode = true) => {
			const dumped: Record<string, unknown> = {};
			for (const [key, value] of pluginStorageData) dumped[key] = stripCode ? stripPackageCode(value) : value;
			return dumped;
		}),
	};
});

vi.mock("./LunaPlugin", () => ({ LunaPlugin: { pluginStorage, dumpStorage, migrateToCore } }));

const pluginStorageStore = ReactiveStore.getStore("@luna/pluginStorage");
const lunaStorageStore = ReactiveStore.getStore("@luna/storage");

const validExport = (): ExportData => ({ version: 1, timestamp: "2026-01-02T03:04:05.000Z", stores: {}, featureFlags: null });

const libPlugin = () => ({ enabled: true, package: { name: "@luna/lib", code: "console.log(1)" } });

describe("SettingsTransfer", () => {
	beforeEach(async () => {
		pluginStorageData.clear();
		installedInCore.clear();
		installAnswers.clear();
		vi.clearAllMocks();
		(globalThis as any).__LunaCore = core;
		dumpStorage.mockClear();
		await pluginStorageStore.clear();
		await lunaStorageStore.clear();
	});

	describe("validate", () => {
		test("rejects anything that isn't an object", () => {
			for (const data of [undefined, null, "export", 1, true]) expect(SettingsTransfer.validate(data)).toBe(false);
		});

		test("requires version 1", () => {
			expect(SettingsTransfer.validate({ ...validExport(), version: 2 })).toBe(false);
			expect(SettingsTransfer.validate({ ...validExport(), version: "1" })).toBe(false);
			const noVersion = { ...validExport() } as Record<string, unknown>;
			delete noVersion.version;
			expect(SettingsTransfer.validate(noVersion)).toBe(false);
		});

		test("requires a stores object", () => {
			const noStores = { ...validExport() } as Record<string, unknown>;
			delete noStores.stores;
			expect(SettingsTransfer.validate(noStores)).toBe(false);
			expect(SettingsTransfer.validate({ ...validExport(), stores: null })).toBe(false);
			expect(SettingsTransfer.validate({ ...validExport(), stores: "" })).toBe(false);
		});

		test("rejects a store that restore couldn't write back", () => {
			expect(SettingsTransfer.validate({ ...validExport(), stores: { "@luna/storage": null } })).toBe(false);
			expect(SettingsTransfer.validate({ ...validExport(), stores: { "@luna/storage": [] } })).toBe(false);
			expect(SettingsTransfer.validate({ ...validExport(), stores: { "@luna/storage": "nope" } })).toBe(false);
		});

		test("accepts a well formed export", () => {
			expect(SettingsTransfer.validate(validExport())).toBe(true);
			expect(SettingsTransfer.validate({ ...validExport(), stores: { "@luna/storage": { a: 1 }, "@luna/plugins": {} } })).toBe(true);
			// featureFlags is not required to be an object
			expect(SettingsTransfer.validate({ ...validExport(), featureFlags: { beta: true } })).toBe(true);
		});

		test("narrows the type, so a validated export can be restored", async () => {
			const data: unknown = { ...validExport(), stores: { "@luna/storage": { restored: 1 } } };

			expect(SettingsTransfer.validate(data)).toBe(true);
			if (!SettingsTransfer.validate(data)) throw new Error("unreachable");
			await SettingsTransfer.restore(data);

			expect(await lunaStorageStore.dump()).toEqual({ restored: 1 });
		});
	});

	describe("dump", () => {
		test("writes every exportable store under its idb name, with a version and an ISO timestamp", async () => {
			await lunaStorageStore.set("setting", { value: 1 });
			await pluginStorageStore.set("flag", true);
			pluginStorageData.set("@luna/lib", libPlugin());

			const started = Date.now();
			const dumped = await SettingsTransfer.dump();
			const finished = Date.now();

			expect(dumped.version).toBe(1);
			expect(dumped.featureFlags).toBeNull();
			expect(Object.keys(dumped.stores).sort()).toEqual(["@luna/pluginStorage", "@luna/plugins", "@luna/storage"]);
			expect(dumped.stores["@luna/storage"]).toEqual({ setting: { value: 1 } });
			expect(dumped.stores["@luna/pluginStorage"]).toEqual({ flag: true });

			expect(new Date(dumped.timestamp).toISOString()).toBe(dumped.timestamp);
			expect(Date.parse(dumped.timestamp)).toBeGreaterThanOrEqual(started);
			expect(Date.parse(dumped.timestamp)).toBeLessThanOrEqual(finished);
		});

		test("strips the plugin code by default", async () => {
			pluginStorageData.set("@luna/lib", libPlugin());

			const dumped = await SettingsTransfer.dump();

			expect(dumpStorage).toHaveBeenCalledWith(true);
			expect(dumped.stores["@luna/plugins"]).toEqual({ "@luna/lib": { enabled: true, package: { name: "@luna/lib" } } });
		});

		test("passes stripCode through to the plugin storage dump", async () => {
			pluginStorageData.set("@luna/lib", libPlugin());

			const dumped = await SettingsTransfer.dump(false);

			expect(dumpStorage).toHaveBeenCalledWith(false);
			expect(dumped.stores["@luna/plugins"]).toEqual({ "@luna/lib": libPlugin() });
		});

		test("passes featureFlags through", async () => {
			const featureFlags = { beta: true, legacy: false };

			const dumped = await SettingsTransfer.dump(true, featureFlags);

			expect(dumped.featureFlags).toBe(featureFlags);
		});

		test("dumps an empty export when the stores are empty", async () => {
			const dumped = await SettingsTransfer.dump();

			expect(dumped.stores).toEqual({ "@luna/pluginStorage": {}, "@luna/plugins": {}, "@luna/storage": {} });
			expect(dumped.installed).toEqual([]);
		});

		test("lists what Luna core has installed, after handing the page's plugins over to it", async () => {
			installedInCore.set("https://store.example/one", { url: "https://store.example/one", name: "one", enabled: false, extra: 1 } as any);

			const dumped = await SettingsTransfer.dump();

			expect(migrateToCore).toHaveBeenCalledTimes(1);
			expect(dumped.installed).toEqual([{ url: "https://store.example/one", name: "one", enabled: false }]);
		});
	});

	describe("restore", () => {
		test("clears a store before writing its payload, so keys the export lacks are dropped", async () => {
			await lunaStorageStore.set("stale", { value: 1 });
			pluginStorageData.set("@luna/lib", libPlugin());

			await SettingsTransfer.restore({ ...validExport(), stores: { "@luna/storage": { fresh: { value: 2 } } } });

			expect(await lunaStorageStore.dump()).toEqual({ fresh: { value: 2 } });
		});

		test("writes every key of a store, through the plugin storage for @luna/plugins", async () => {
			pluginStorageData.set("gone", { enabled: false });

			await SettingsTransfer.restore({
				...validExport(),
				stores: { "@luna/plugins": { "@luna/lib": { enabled: true }, "@luna/ui": { enabled: false } } },
			});

			expect([...pluginStorageData.keys()].sort()).toEqual(["@luna/lib", "@luna/ui"]);
			expect(pluginStorageData.get("@luna/ui")).toEqual({ enabled: false });
		});

		const exported = (installed: unknown): ExportData => ({ ...validExport(), installed }) as ExportData;

		test("installs the exported plugins through Luna core and uninstalls the others", async () => {
			installedInCore.set("https://store.example/old", { url: "https://store.example/old", name: "old", enabled: true });

			const notInstalled = await SettingsTransfer.restore(
				exported([
					{ url: "https://store.example/new", name: "new", enabled: true },
					// A core plugin is never installed through the list, the url is only trusted from Luna
					{ url: "https://luna/luna.lib", name: "lib", enabled: true },
					{ url: "javascript:alert(1)", name: "bad", enabled: true },
				]),
			);

			expect(notInstalled).toEqual([]);
			expect(core.uninstall).toHaveBeenCalledWith("https://store.example/old");
			expect(core.install.mock.calls).toEqual([["https://store.example/new"]]);
			expect([...installedInCore.keys()]).toEqual(["https://store.example/new"]);
		});

		test("names the plugins that were declined or could not be installed", async () => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			installAnswers.set("https://store.example/declined", false);
			installAnswers.set("https://store.example/broken", new Error("core cannot ask"));

			const notInstalled = await SettingsTransfer.restore(
				exported([
					{ url: "https://store.example/declined", name: "declined" },
					{ url: "https://store.example/broken", name: "broken" },
					{ url: "https://store.example/fine", name: "fine" },
				]),
			);

			expect(notInstalled).toEqual(["declined", "broken"]);
			expect([...installedInCore.keys()]).toEqual(["https://store.example/fine"]);
		});

		test("a plugin exported disabled is turned off, without asking again when it is installed already", async () => {
			installedInCore.set("https://store.example/here", { url: "https://store.example/here", name: "here", enabled: true });

			await SettingsTransfer.restore(
				exported([
					{ url: "https://store.example/here", name: "here", enabled: false },
					{ url: "https://store.example/there", name: "there", enabled: false },
				]),
			);

			expect(core.install.mock.calls).toEqual([["https://store.example/there"]]);
			expect(installedInCore.get("https://store.example/here")!.enabled).toBe(false);
			expect(installedInCore.get("https://store.example/there")!.enabled).toBe(false);
		});

		test("an export from before Luna core is read from the page's plugin copies", async () => {
			const entry = (installed: boolean, enabled?: boolean) => ({
				installed,
				enabled,
				url: "https://store.example/old-export",
				package: { name: "from-copy" },
			});

			await SettingsTransfer.restore({
				...validExport(),
				stores: { "@luna/plugins": { copy: entry(true), "@luna/lib": { installed: true, enabled: true }, off: { installed: false } } },
			});

			expect(migrateToCore).toHaveBeenCalledTimes(1);
			expect(core.install.mock.calls).toEqual([["https://store.example/old-export"]]);
		});

		test("leaves stores the payload doesn't mention alone", async () => {
			await pluginStorageStore.set("keep", true);
			pluginStorageData.set("@luna/lib", libPlugin());

			await SettingsTransfer.restore({ ...validExport(), stores: { "@luna/storage": { written: 1 } } });

			expect(await pluginStorageStore.dump()).toEqual({ keep: true });
			expect([...pluginStorageData.keys()]).toEqual(["@luna/lib"]);
			expect(await lunaStorageStore.dump()).toEqual({ written: 1 });
		});

		test("a dump can be restored", async () => {
			await lunaStorageStore.set("a", 1);
			await pluginStorageStore.set("b", { nested: [1, 2] });
			pluginStorageData.set("@luna/lib", libPlugin());
			const dumped = await SettingsTransfer.dump(false);

			await lunaStorageStore.clear();
			await pluginStorageStore.clear();
			pluginStorageData.clear();
			await SettingsTransfer.restore(dumped);

			expect(await lunaStorageStore.dump()).toEqual(dumped.stores["@luna/storage"]);
			expect(await pluginStorageStore.dump()).toEqual(dumped.stores["@luna/pluginStorage"]);
			expect(Object.fromEntries(pluginStorageData)).toEqual(dumped.stores["@luna/plugins"]);
		});
	});
});
