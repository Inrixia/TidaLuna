import { effect } from "oby";

const byName = new Intl.Collator(undefined, { sensitivity: "base" });

export function installedPlugins<T extends { installed: boolean; name: string }>(plugins: T[], core: ReadonlySet<string>, descending: boolean) {
	return plugins
		.filter((plugin) => plugin.installed && !core.has(plugin.name))
		.sort((a, b) => (descending ? byName.compare(b.name, a.name) : byName.compare(a.name, b.name)));
}

export function matchingPluginNames<T extends { name: string }>(plugins: T[], query: string) {
	const search = query.trim().toLocaleLowerCase();
	return new Set(plugins.filter((plugin) => plugin.name.toLocaleLowerCase().includes(search)));
}

export function watchInstalledPlugins<T extends { installed: boolean; name: string }>(
	registry: Record<string, T>,
	core: ReadonlySet<string>,
	descending: boolean,
	update: (plugins: T[]) => void,
) {
	// Track registry membership as well as install flags, including when the tab first opens empty.
	return effect(() => update(installedPlugins(Object.values(registry), core, descending)), { sync: true });
}
