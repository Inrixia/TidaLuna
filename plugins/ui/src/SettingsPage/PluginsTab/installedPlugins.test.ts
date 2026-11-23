import assert from "node:assert/strict";
import test from "node:test";
import { store } from "oby";
import { installedPlugins, matchingPluginNames, watchInstalledPlugins } from "./installedPlugins";

const item = (name: string, installed = true, isCore = false) => ({ name, installed, isCore });
const z = item("Zulu");
const a = item("alpha");
// Named like a core plugin but not served by Luna: listed, so it can be turned off and removed
const lookalike = item("@luna/ui");
const plugins = [z, item("store", false), item("core", true, true), a];

test("updates an already open list after installing its first plugin and after uninstall", async () => {
	const registry = store<Record<string, ReturnType<typeof item>>>({});
	let names: string[] = [];
	const dispose = watchInstalledPlugins(registry, false, (plugins) => {
		names = plugins.map((plugin) => plugin.name);
	});
	try {
		assert.deepEqual(names, []);
		registry.preview = item("Preview", false);
		await Promise.resolve();
		assert.deepEqual(names, []);
		registry.preview.installed = true;
		await Promise.resolve();
		assert.deepEqual(names, ["Preview"]);
		delete registry.preview;
		await Promise.resolve();
		assert.deepEqual(names, []);
	} finally {
		dispose();
	}
});

test("sorts installed non-core plugins in either direction without changing registry order", () => {
	assert.deepEqual(installedPlugins(plugins, false), [a, z]);
	assert.deepEqual(installedPlugins(plugins, true), [z, a]);
	assert.equal(plugins[0], z);
	assert.deepEqual(installedPlugins([], false), []);
	assert.deepEqual(installedPlugins([lookalike], false), [lookalike]);
});

test("matches partial names ignoring case and surrounding whitespace", () => {
	const list = installedPlugins(plugins, true);
	assert.deepEqual([...matchingPluginNames(list, "  LP  ")], [a]);
	assert.deepEqual([...matchingPluginNames(list, "   ")], [z, a]);
	assert.equal(matchingPluginNames(list, "store").size, 0);
});
