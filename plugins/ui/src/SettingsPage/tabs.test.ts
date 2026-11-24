import { beforeEach, describe, expect, test, vi } from "vitest";
import type { LunaUnload } from "@luna/core";
import type { SettingsTab, SettingsTabOverride } from "./tabs";

/**
 * `tabs.ts` keeps its registry, its override list and both Signals (`settingsTabsVersion`, `currentSettingsTab`)
 * at module scope. Register/override are only undone by their unloads and `addBuiltInSettingsTab` (how @luna/ui
 * adds its own tabs at init) can't be undone at all, so every test takes a fresh module instead of cleaning up
 * the shared one.
 */
let tabs: typeof import("./tabs");

beforeEach(async () => {
	vi.resetModules();
	tabs = await import("./tabs");
});

const makeUnloads = () => new Set<LunaUnload>();
const makeTab = (id: string, extra: Partial<SettingsTab> = {}): SettingsTab => ({
	id,
	label: id,
	order: 100,
	content: `${id} content`,
	...extra,
});
const ids = () => tabs.SettingsTabs.list().map((tab) => tab.id);
/** Runs a plugin's unloads the way unloadSet does, without awaiting: every unload here is synchronous */
const runUnloads = (unloads: Set<LunaUnload>) => [...unloads].forEach((unload) => unload());

describe("SettingsTabs.register", () => {
	test("adds a tab and lists all tabs sorted by order", () => {
		const unloads = makeUnloads();
		tabs.SettingsTabs.register(unloads, makeTab("Late", { order: 300, label: "Late tab" }));
		tabs.SettingsTabs.register(unloads, makeTab("Early", { order: 100 }));
		tabs.SettingsTabs.register(unloads, makeTab("Middle", { order: 200 }));

		expect(ids()).toEqual(["Early", "Middle", "Late"]);
		// The registered fields are what list() hands back
		expect(tabs.SettingsTabs.list()[2]).toEqual({ id: "Late", label: "Late tab", order: 300, content: "Late content" });
	});

	test("registering an id that is already taken throws and keeps the existing tab", () => {
		const unloads = makeUnloads();
		const first = makeTab("Plugins");
		tabs.SettingsTabs.register(unloads, first);

		expect(() => tabs.SettingsTabs.register(makeUnloads(), makeTab("Plugins", { label: "Shadow" }))).toThrow(
			'Settings tab "Plugins" is already registered',
		);
		expect(tabs.SettingsTabs.list()).toEqual([first]);

		// Built-in tabs hold their ids too
		tabs.addBuiltInSettingsTab(makeTab("Settings", { order: 400 }));
		expect(() => tabs.SettingsTabs.register(makeUnloads(), makeTab("Settings"))).toThrow('Settings tab "Settings" is already registered');
		expect(ids()).toEqual(["Plugins", "Settings"]);
	});

	test("unloading removes the tab and allows registering the id again", () => {
		const unloads = makeUnloads();
		tabs.SettingsTabs.register(unloads, makeTab("Plugins"));
		expect(ids()).toEqual(["Plugins"]);

		runUnloads(unloads);
		expect(ids()).toEqual([]);

		tabs.SettingsTabs.register(makeUnloads(), makeTab("Plugins", { label: "Reloaded" }));
		expect(tabs.SettingsTabs.list()[0].label).toBe("Reloaded");
	});

	test("an old unload does not remove a newer tab registered with the same id", () => {
		const oldUnloads = makeUnloads();
		tabs.SettingsTabs.register(oldUnloads, makeTab("Plugins", { label: "Old" }));
		const oldUnload = [...oldUnloads][0];

		runUnloads(oldUnloads);
		expect(ids()).toEqual([]);

		const replacement = makeTab("Plugins", { label: "New" });
		tabs.SettingsTabs.register(makeUnloads(), replacement);
		const version = tabs.settingsTabsVersion._;

		// A late second run of the old unload (and the version bump it would cause) must not hit the replacement
		oldUnload();
		expect(tabs.SettingsTabs.list()).toEqual([replacement]);
		expect(tabs.settingsTabsVersion._).toBe(version);
	});
});

describe("SettingsTabs.override", () => {
	test("applies the overridden fields but never the id", () => {
		tabs.addBuiltInSettingsTab(makeTab("Plugins", { order: 100 }));
		const unloads = makeUnloads();

		// `id` is not part of SettingsTabOverride; list() pins it back to the tab's own id when it is passed anyway
		const attempt = { id: "Hijacked", label: "Plugins!", content: "patched", order: 400, hidden: true, keepAlive: true };
		tabs.SettingsTabs.override(unloads, "Plugins", attempt as unknown as SettingsTabOverride);

		expect(tabs.SettingsTabs.list()).toEqual([
			{ id: "Plugins", label: "Plugins!", order: 400, content: "patched", hidden: true, keepAlive: true },
		]);
	});

	test("later overrides win and unloading one reverts to the state before it", () => {
		const builtIn = makeTab("Settings", { order: 400, content: "built-in" });
		tabs.addBuiltInSettingsTab(builtIn);

		const first = makeUnloads();
		const second = makeUnloads();
		tabs.SettingsTabs.override(first, "Settings", { label: "First", order: 50 });
		tabs.SettingsTabs.override(second, "Settings", { label: "Second" });

		// Later override wins, the earlier one still applies for the fields it set
		expect(tabs.SettingsTabs.list()).toEqual([{ ...builtIn, label: "Second", order: 50 }]);

		runUnloads(second);
		expect(tabs.SettingsTabs.list()).toEqual([{ ...builtIn, label: "First", order: 50 }]);

		runUnloads(first);
		expect(tabs.SettingsTabs.list()).toEqual([builtIn]);
	});

	test("overriding an unknown id registers nothing", () => {
		const unloads = makeUnloads();
		tabs.SettingsTabs.override(unloads, "Nope", { label: "Ghost" });

		expect(tabs.SettingsTabs.list()).toEqual([]);
	});

	test("running an override's unload twice only reverts it once", () => {
		const builtIn = makeTab("Settings", { order: 400 });
		tabs.addBuiltInSettingsTab(builtIn);
		const overridden = makeUnloads();
		tabs.SettingsTabs.override(overridden, "Settings", { label: "Patched" });
		const unload = [...overridden][0];

		unload();
		expect(tabs.SettingsTabs.list()).toEqual([builtIn]);
		const version = tabs.settingsTabsVersion._;

		// The entry is already gone, so a second run (e.g. one unload held by two sets) must be a no-op
		unload();
		expect(tabs.SettingsTabs.list()).toEqual([builtIn]);
		expect(tabs.settingsTabsVersion._).toBe(version);
	});
});

describe("SettingsTabs.list", () => {
	test("includes hidden tabs, for both registered and overridden tabs", () => {
		tabs.addBuiltInSettingsTab(makeTab("Plugins", { order: 100 }));
		tabs.SettingsTabs.register(makeUnloads(), makeTab("Secret", { order: 200, hidden: true }));

		expect(ids()).toEqual(["Plugins", "Secret"]);
		expect(tabs.SettingsTabs.list()[1].hidden).toBe(true);

		// Hiding a built-in keeps it listed as well, the page filters hidden tabs itself
		tabs.SettingsTabs.override(makeUnloads(), "Plugins", { hidden: true });
		expect(ids()).toEqual(["Plugins", "Secret"]);
		expect(tabs.SettingsTabs.list().every((tab) => tab.hidden === true)).toBe(true);
	});

	test("an override still applies when its tab is unloaded and registered again", () => {
		const registered = makeUnloads();
		const overridden = makeUnloads();
		tabs.SettingsTabs.register(registered, makeTab("Plugins"));
		tabs.SettingsTabs.override(overridden, "Plugins", { hidden: true });

		// Overrides are keyed by id, so unloading the tab leaves the override in place and it hits the next tab
		runUnloads(registered);
		expect(tabs.SettingsTabs.list()).toEqual([]);

		tabs.SettingsTabs.register(makeUnloads(), makeTab("Plugins"));
		expect(tabs.SettingsTabs.list()[0].hidden).toBe(true);
	});
});

describe("SettingsTabs.onUpdate", () => {
	test("fires on register, override and their unloads, and its unload detaches it", () => {
		const registered = makeUnloads();
		const overridden = makeUnloads();
		const listener = makeUnloads();
		const updates = vi.fn();

		tabs.SettingsTabs.onUpdate(listener, updates);
		// Signal.onValue calls back straight away with the current value
		expect(updates).toHaveBeenCalledTimes(1);

		tabs.SettingsTabs.register(registered, makeTab("Plugins"));
		expect(updates).toHaveBeenCalledTimes(2);

		tabs.SettingsTabs.override(overridden, "Plugins", { label: "Patched" });
		expect(updates).toHaveBeenCalledTimes(3);

		runUnloads(overridden);
		expect(updates).toHaveBeenCalledTimes(4);

		runUnloads(registered);
		expect(updates).toHaveBeenCalledTimes(5);

		runUnloads(listener);
		tabs.SettingsTabs.register(makeUnloads(), makeTab("Themes"));
		tabs.SettingsTabs.override(makeUnloads(), "Themes", { label: "Patched" });
		expect(updates).toHaveBeenCalledTimes(5);
	});

	test("the unload it returns detaches the callback too", () => {
		const updates = vi.fn();
		const unload = tabs.SettingsTabs.onUpdate(makeUnloads(), updates);

		tabs.SettingsTabs.register(makeUnloads(), makeTab("Plugins"));
		expect(updates).toHaveBeenCalledTimes(2);

		unload();
		tabs.SettingsTabs.register(makeUnloads(), makeTab("Themes"));
		expect(updates).toHaveBeenCalledTimes(2);
	});
});

describe("SettingsTabs.onChange and open/current", () => {
	test("open() moves current and notifies onChange listeners until they unload", () => {
		expect(tabs.SettingsTabs.current).toBe("Plugins");

		const selected: string[] = [];
		const unload = tabs.SettingsTabs.onChange(makeUnloads(), (id) => selected.push(id));
		// Called immediately with the currently selected tab
		expect(selected).toEqual(["Plugins"]);

		tabs.SettingsTabs.open("Themes");
		expect(tabs.SettingsTabs.current).toBe("Themes");
		expect(selected).toEqual(["Plugins", "Themes"]);

		// Signal ignores a write of the same value, so no duplicate notification
		tabs.SettingsTabs.open("Themes");
		expect(selected).toEqual(["Plugins", "Themes"]);

		unload();
		tabs.SettingsTabs.open("Settings");
		expect(tabs.SettingsTabs.current).toBe("Settings");
		expect(selected).toEqual(["Plugins", "Themes"]);
	});

	test("onChange's unload in the plugin's unloads set detaches it as well", () => {
		const unloads = makeUnloads();
		const selected: string[] = [];
		tabs.SettingsTabs.onChange(unloads, (id) => selected.push(id));

		runUnloads(unloads);
		tabs.SettingsTabs.open("Supporters");

		expect(selected).toEqual(["Plugins"]);
		expect(tabs.SettingsTabs.current).toBe("Supporters");
	});
});

describe("settingsTabsVersion", () => {
	test("bumps on every tab and override change, including their unloads", () => {
		// Fresh module, so the counter starts at 0
		expect(tabs.settingsTabsVersion._).toBe(0);

		const registered = makeUnloads();
		tabs.SettingsTabs.register(registered, makeTab("Plugins"));
		expect(tabs.settingsTabsVersion._).toBe(1);

		const overridden = makeUnloads();
		tabs.SettingsTabs.override(overridden, "Plugins", { label: "Patched" });
		expect(tabs.settingsTabsVersion._).toBe(2);

		runUnloads(overridden);
		expect(tabs.settingsTabsVersion._).toBe(3);

		runUnloads(registered);
		expect(tabs.settingsTabsVersion._).toBe(4);

		// Selecting a tab is tracked by currentSettingsTab, not by the version
		tabs.SettingsTabs.open("Themes");
		expect(tabs.settingsTabsVersion._).toBe(4);

		// addBuiltInSettingsTab runs while @luna/ui initialises, before anything can listen
		tabs.addBuiltInSettingsTab(makeTab("Settings", { order: 400 }));
		expect(tabs.settingsTabsVersion._).toBe(4);
	});
});
