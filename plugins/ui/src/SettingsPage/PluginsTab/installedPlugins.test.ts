import { store } from "oby";
import { expect, test } from "vitest";
import { installedPlugins, matchingPluginNames, watchInstalledPlugins } from "./installedPlugins";

const item = (name: string, installed = true) => ({ name, installed });
const z = item("Zulu");
const a = item("alpha");
const core = new Set(["core"]);
const plugins = [z, item("store", false), item("core"), a];

test("updates an already open list after installing its first plugin and after uninstall", async () => {
	const registry = store<Record<string, ReturnType<typeof item>>>({});
	const updates: string[][] = [];
	const dispose = watchInstalledPlugins(registry, core, false, (plugins) => {
		updates.push(plugins.map((plugin) => plugin.name));
	});

	// The effect is synchronous, so the first update is the empty registry
	expect(updates).toEqual([[]]);

	registry.preview = item("Preview", false);
	await Promise.resolve();
	// Tracked, but not installed yet
	expect(updates.at(-1)).toEqual([]);

	registry.preview.installed = true;
	await Promise.resolve();
	expect(updates.at(-1)).toEqual(["Preview"]);

	delete registry.preview;
	await Promise.resolve();
	expect(updates.at(-1)).toEqual([]);

	// Disposing the effect stops the watching
	dispose();
	registry.other = item("Other");
	await Promise.resolve();
	expect(updates.at(-1)).toEqual([]);
});

test("notices a plugin being added to a registry that already has installed plugins", async () => {
	const registry = store<Record<string, ReturnType<typeof item>>>({ Zulu: item("Zulu"), core: item("core") });
	const updates: string[][] = [];
	const dispose = watchInstalledPlugins(registry, core, false, (plugins) => {
		updates.push(plugins.map((plugin) => plugin.name));
	});

	registry.alpha = item("alpha", false);
	await Promise.resolve();
	expect(updates.at(-1)).toEqual(["Zulu"]);

	registry.alpha.installed = true;
	await Promise.resolve();
	expect(updates.at(-1)).toEqual(["alpha", "Zulu"]);

	dispose();
});

test("watchInstalledPlugins applies the core filter and sort direction on every update", async () => {
	const registry = store<Record<string, ReturnType<typeof item>>>({ Zulu: item("Zulu"), core: item("core"), alpha: item("alpha") });
	const updates: string[][] = [];
	const dispose = watchInstalledPlugins(registry, core, true, (plugins) => {
		updates.push(plugins.map((plugin) => plugin.name));
	});

	expect(updates).toEqual([["Zulu", "alpha"]]);

	registry.beta = item("beta");
	await Promise.resolve();
	expect(updates.at(-1)).toEqual(["Zulu", "beta", "alpha"]);

	dispose();
});

test("sorts installed non-core plugins in either direction without changing registry order", () => {
	expect(installedPlugins(plugins, core, false)).toEqual([a, z]);
	expect(installedPlugins(plugins, core, true)).toEqual([z, a]);
	expect(plugins[0]).toBe(z);
	expect(plugins.map((plugin) => plugin.name)).toEqual(["Zulu", "store", "core", "alpha"]);
	expect(installedPlugins([], core, false)).toEqual([]);
});

test("collates case-insensitively, so uppercase names don't jump to the front", () => {
	expect(installedPlugins([item("Zulu"), item("alpha")], new Set(), false).map((plugin) => plugin.name)).toEqual(["alpha", "Zulu"]);
	expect(installedPlugins([item("Zulu"), item("alpha")], new Set(), true).map((plugin) => plugin.name)).toEqual(["Zulu", "alpha"]);
});

test("filters out core and not installed plugins", () => {
	expect(installedPlugins(plugins, core, false).map((plugin) => plugin.name)).toEqual(["alpha", "Zulu"]);
	expect(installedPlugins(plugins, new Set(), false).map((plugin) => plugin.name)).toEqual(["alpha", "core", "Zulu"]);
	expect(installedPlugins([item("only", false)], core, false)).toEqual([]);
});

test("matches partial names ignoring case and surrounding whitespace", () => {
	const list = installedPlugins(plugins, core, true);
	expect([...matchingPluginNames(list, "  LP  ")]).toEqual([a]);
	expect([...matchingPluginNames(list, "   ")]).toEqual([z, a]);
	expect(matchingPluginNames(list, "store").size).toBe(0);
	// Lowercases the plugin names too, and an uninstalled plugin can still match
	expect([...matchingPluginNames(plugins, "ZULU")]).toEqual([z]);
	expect([...matchingPluginNames(plugins, "core")]).toEqual([item("core")]);
});
