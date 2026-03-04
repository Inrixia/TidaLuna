import { LunaPlugin, Tracer, type LunaPackageDependency } from "@luna/core";

import { confirm } from "../../helpers/confirm";
import { addToStores, storeUrls } from "./storeState";

type StorePackage = {
	plugins: string[];
};

// #region Trace
const trace = Tracer("[@luna/ui][PluginInstall]", null).trace;
// #endregion

// #region URL Helpers
const normalizeStoreUrl = (storeUrl: string) => storeUrl.replace(/\/store\.json$/i, "");
const normalizePluginUrl = (pluginUrl: string) => pluginUrl.replace(/(\.mjs|\.json|\.mjs\.map)$/i, "");
const isStoreAdded = (storeUrl: string) => storeUrls.includes(normalizeStoreUrl(storeUrl));
const isBuiltInDevStore = (storeUrl: string) => /^https?:\/\/(127\.0\.0\.1|localhost):3000$/i.test(normalizeStoreUrl(storeUrl));
const isFromDevStore = (plugin: LunaPlugin) => /^https?:\/\/(127\.0\.0\.1|localhost):3000\//i.test(plugin.url);
const getDependencyStoreUrl = (dependency: LunaPackageDependency, dependantPlugin: LunaPlugin) => {
	if (isFromDevStore(dependantPlugin) && dependency.devStoreUrl) return dependency.devStoreUrl;
	return dependency.storeUrl;
};
// #endregion

// #region Candidate Resolution
const toPluginIdCandidates = (value: string): string[] => {
	const trimmed = value.trim();
	const withoutScopeAt = trimmed.replace(/^@/, "");
	const safeName = trimmed.replace(/@/g, "").replace(/\//g, ".");
	const dottedScope = withoutScopeAt.replace(/\//g, ".");
	const atWithDots = trimmed.replace(/\//g, ".");
	const spaced = trimmed.replace(/\s+/g, ".");

	return [...new Set([trimmed, withoutScopeAt, safeName, dottedScope, atWithDots, spaced].filter(Boolean))];
};

const toPluginUrlCandidates = (storeUrl: string, pluginId: string): string[] => {
	const normalizedStoreUrl = normalizeStoreUrl(storeUrl);
	const isLocalDevStore = isBuiltInDevStore(normalizedStoreUrl);
	if (/^https?:\/\//i.test(pluginId)) return [normalizePluginUrl(pluginId)];
	const candidates = toPluginIdCandidates(pluginId);

	if (isLocalDevStore) return candidates.map((candidate) => normalizePluginUrl(`${normalizedStoreUrl}/${candidate}`));
	return candidates.map((candidate) => normalizePluginUrl(`${normalizedStoreUrl}/${candidate.replace(/\s+/g, ".")}`));
};

const resolvedPluginUrlCache = new Map<string, string>();
// #endregion

// #region Store Lookup
const getStorePluginUrls = async (storeUrl: string): Promise<string[]> => {
	const normalizedStoreUrl = normalizeStoreUrl(storeUrl);
	const response = await fetch(`${normalizedStoreUrl}/store.json`);
	if (!response.ok) {
		trace.msg.err(`Failed to fetch plugin store '${normalizedStoreUrl}': ${response.statusText}`);
		return [];
	}

	const storePackage = (await response.json()) as StorePackage;

	return [...new Set((storePackage.plugins ?? []).flatMap((pluginId) => toPluginUrlCandidates(normalizedStoreUrl, pluginId)))];
};

const tryResolveFromUrls = async (pluginUrls: string[], pluginName: string, cacheKey: string): Promise<string | undefined> => {
	for (const pluginUrl of pluginUrls) {
		try {
			const normalizedPluginUrl = normalizePluginUrl(pluginUrl);
			const pkg = await LunaPlugin.fetchPackage(normalizedPluginUrl);
			if (pkg.name !== pluginName) continue;
			resolvedPluginUrlCache.set(cacheKey, normalizedPluginUrl);
			return normalizedPluginUrl;
		} catch {
			// Ignore invalid entries and continue resolving
		}
	}
};

const resolvePluginUrlByName = async (storeUrl: string, pluginName: string): Promise<string | undefined> => {
	const normalizedStoreUrl = normalizeStoreUrl(storeUrl);
	const cacheKey = `${normalizedStoreUrl}::${pluginName}`;
	const cached = resolvedPluginUrlCache.get(cacheKey);
	if (cached) return cached;

	const pluginUrls = await getStorePluginUrls(normalizedStoreUrl);
	const resolvedFromStore = await tryResolveFromUrls(pluginUrls, pluginName, cacheKey);
	if (resolvedFromStore) return resolvedFromStore;

	const directCandidates = toPluginUrlCandidates(normalizedStoreUrl, pluginName);
	const resolvedFromDirect = await tryResolveFromUrls(directCandidates, pluginName, cacheKey);
	if (resolvedFromDirect) return resolvedFromDirect;

	trace.msg.err(`Dependency resolution candidates for '${pluginName}':`, [...new Set([...pluginUrls, ...directCandidates])]);
	trace.msg.err(`Failed to resolve dependency '${pluginName}' from store '${normalizedStoreUrl}'.`);
	return;
};
// #endregion

// #region User Prompts
const ensureStoreForDependency = async ({ name, storeUrl }: LunaPackageDependency, dependantName: string) => {
	const normalizedStoreUrl = normalizeStoreUrl(storeUrl);
	if (isBuiltInDevStore(normalizedStoreUrl)) return true;
	if (isStoreAdded(normalizedStoreUrl)) return true;

	try {
		await confirm({
			title: "Add dependency store?",
			description: `Plugin '${dependantName}' requires library '${name}' from '${normalizedStoreUrl}'. Add this store now?`,
			confirmationText: "Add store",
		});
	} catch {
		trace.msg.err(`Install cancelled: '${dependantName}' needs '${name}', but its plugin store was not added.`);
		return false;
	}

	addToStores(normalizedStoreUrl);
	return true;
};

const confirmInstallDependency = async ({ name }: LunaPackageDependency, dependantName: string) => {
	try {
		await confirm({
			title: "Install required library?",
			description: `Plugin '${dependantName}' depends on library plugin '${name}'. Install it now?`,
			confirmationText: "Install library",
		});
	} catch {
		trace.msg.err(`Install cancelled: '${dependantName}' requires library '${name}'.`);
		return false;
	}
	return true;
};
// #endregion

// #region Install Helpers
const installDependency = async (dependency: LunaPackageDependency, dependantPlugin: LunaPlugin, visited: Set<string>) => {
	const dependencyStoreUrl = getDependencyStoreUrl(dependency, dependantPlugin);
	const dependencyWithStore = { ...dependency, storeUrl: dependencyStoreUrl };
	const existingDependency = LunaPlugin.getByName(dependency.name);
	if (existingDependency?.installed) return existingDependency;
	if (existingDependency !== undefined) {
		if (!(await confirmInstallDependency(dependencyWithStore, dependantPlugin.name))) return;
		const didInstallExisting = await installPluginWithLibraries(existingDependency, visited);
		if (didInstallExisting && existingDependency.installed) return existingDependency;
	}

	if (!(await ensureStoreForDependency(dependencyWithStore, dependantPlugin.name))) return;
	if (!(await confirmInstallDependency(dependencyWithStore, dependantPlugin.name))) return;

	const dependencyUrl = await resolvePluginUrlByName(dependencyWithStore.storeUrl, dependencyWithStore.name);
	if (dependencyUrl === undefined) {
		trace.msg.err(`Could not find dependency '${dependency.name}' in store '${normalizeStoreUrl(dependencyWithStore.storeUrl)}'.`);
		return;
	}

	const dependencyPlugin = await LunaPlugin.fromStorage({ url: dependencyUrl });
	const didInstall = await installPluginWithLibraries(dependencyPlugin, visited);
	if (!didInstall) return;
	return dependencyPlugin;
};
// #endregion

// #region Public API
export const installPluginWithLibraries = async (plugin: LunaPlugin, visited = new Set<string>()) => {
	if (visited.has(plugin.name)) return true;
	visited.add(plugin.name);

	try {
		const dependencyRequirements = plugin.dependencyRequirements;
		for (const dependency of dependencyRequirements) {
			const dependencyPlugin = await installDependency(dependency, plugin, visited);
			if (dependencyPlugin === undefined || !dependencyPlugin.installed) {
				trace.msg.err(`Skipping install of '${plugin.name}' because dependency '${dependency.name}' is unavailable.`);
				return false;
			}
		}

		if (!plugin.installed) {
			await plugin.install();
			if (plugin.isLibrary) trace.msg.log(`Installed library plugin ${plugin.name}.`);
		}

		return plugin.installed;
	} catch (err) {
		trace.msg.err.withContext(`Failed to install plugin '${plugin.name}'`)(err);
		return false;
	}
};

export const uninstallPluginWithDependenciesCheck = async (plugin: LunaPlugin) => {
	try {
		await plugin.uninstall();
		return !plugin.installed;
	} catch (err) {
		trace.msg.err.withContext(`Failed to uninstall plugin '${plugin.name}'`)(err);
		return false;
	}
};
// #endregion
