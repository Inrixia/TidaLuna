import { effect } from "oby";

const byName = new Intl.Collator(undefined, { sensitivity: "base" });

/** A plugin is core by its url and name together (LunaPlugin.isCore): a plugin only named like one is listed */
type Listed = { installed: boolean; name: string; isCore: boolean };

export function installedPlugins<T extends Listed>(plugins: T[], descending: boolean) {
	return plugins
		.filter((plugin) => plugin.installed && !plugin.isCore)
		.sort((a, b) => (descending ? byName.compare(b.name, a.name) : byName.compare(a.name, b.name)));
}

export function matchingPluginNames<T extends { name: string }>(plugins: T[], query: string) {
	const search = query.trim().toLocaleLowerCase();
	return new Set(plugins.filter((plugin) => plugin.name.toLocaleLowerCase().includes(search)));
}

export function watchInstalledPlugins<T extends Listed>(registry: Record<string, T>, descending: boolean, update: (plugins: T[]) => void) {
	// Track registry membership as well as install flags, including when the tab first opens empty.
	return effect(() => update(installedPlugins(Object.values(registry), descending)), { sync: true });
}
