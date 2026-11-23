import assert from "node:assert/strict";
import test from "node:test";
import { installedPlugins, matchingPluginNames } from "./installedPlugins.ts";

const item = (name, installed = true) => ({ name, installed });
const z = item("Zulu");
const a = item("alpha");
const core = new Set(["core"]);
const plugins = [z, item("store", false), item("core"), a];

test("sorts installed non-core plugins in either direction without changing registry order", () => {
	assert.deepEqual(installedPlugins(plugins, core, false), [a, z]);
	assert.deepEqual(installedPlugins(plugins, core, true), [z, a]);
	assert.equal(plugins[0], z);
	assert.deepEqual(installedPlugins([], core, false), []);
});

test("matches partial names ignoring case and surrounding whitespace", () => {
	const list = installedPlugins(plugins, core, true);
	assert.deepEqual([...matchingPluginNames(list, "  LP  ")], [a]);
	assert.deepEqual([...matchingPluginNames(list, "   ")], [z, a]);
	assert.equal(matchingPluginNames(list, "store").size, 0);
});
