import type { LunaUnload, LunaUnloads } from "@luna/core";
import { Signal } from "@inrixia/helpers";
import type React from "react";

export type SettingsTabProps = { active: boolean };
export type SettingsTabContent = React.ReactNode | React.ComponentType<SettingsTabProps>;

export interface SettingsTab {
	/** Unique id, also the value of the tab. Built-in ids: "Plugins", "Plugin Store", "Themes", "Settings", "Supporters" */
	id: string;
	label: string;
	icon?: React.ReactElement;
	/** Tabs are sorted by order, built-in tabs use 100, 200, 300... */
	order: number;
	content: SettingsTabContent;
	/** Keep the tab mounted (hidden) after it was first opened instead of unmounting it on every switch */
	keepAlive?: boolean;
	hidden?: boolean;
}
export type SettingsTabOverride = Partial<Omit<SettingsTab, "id">>;

const tabs = new Map<string, SettingsTab>();
const overrides: { id: string; override: SettingsTabOverride }[] = [];

/** Bumped whenever tabs or overrides change */
export const settingsTabsVersion = new Signal(0);
const changed = () => (settingsTabsVersion._ = settingsTabsVersion._ + 1);

/** Currently selected Luna Settings tab id */
export const currentSettingsTab = new Signal<string>("Plugins");

/** Internal, used by @luna/ui for its built-in tabs */
export const addBuiltInSettingsTab = (tab: SettingsTab) => tabs.set(tab.id, tab);

export const SettingsTabs = {
	/**
	 * Add a new tab to Luna Settings. Removed again when unloads run.
	 */
	register(unloads: LunaUnloads, tab: SettingsTab) {
		if (tabs.has(tab.id)) throw new Error(`Settings tab "${tab.id}" is already registered`);
		tabs.set(tab.id, tab);
		changed();
		unloads.add(() => {
			if (tabs.get(tab.id) !== tab) return;
			tabs.delete(tab.id);
			changed();
		});
	},
	/**
	 * Change an existing tab (built-in or registered), e.g. replace its content, hide it or move it.
	 * Later overrides win. Reverted when unloads run.
	 */
	override(unloads: LunaUnloads, id: string, override: SettingsTabOverride) {
		const entry = { id, override };
		overrides.push(entry);
		changed();
		unloads.add(() => {
			const index = overrides.indexOf(entry);
			if (index === -1) return;
			overrides.splice(index, 1);
			changed();
		});
	},
	/** All tabs with overrides applied, sorted by order. Includes hidden tabs. */
	list(): SettingsTab[] {
		const resolved = [...tabs.values()].map((tab) => {
			let next = tab;
			for (const { id, override } of overrides) if (id === tab.id) next = { ...next, ...override, id: tab.id };
			return next;
		});
		return resolved.sort((a, b) => a.order - b.order);
	},
	get current() {
		return currentSettingsTab._;
	},
	/** Switch Luna Settings to the given tab */
	open(id: string) {
		currentSettingsTab._ = id;
	},
	/** Called with the tab id whenever the selected tab changes. Removed again when unloads run. */
	onChange(unloads: LunaUnloads, cb: (id: string) => unknown): LunaUnload {
		const unload: LunaUnload = currentSettingsTab.onValue(cb);
		unloads.add(unload);
		return unload;
	},
	/** Called whenever tabs or overrides change. Removed again when unloads run. */
	onUpdate(unloads: LunaUnloads, cb: () => unknown): LunaUnload {
		const unload: LunaUnload = settingsTabsVersion.onValue(() => cb());
		unloads.add(unload);
		return unload;
	},
};
