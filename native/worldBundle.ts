// Plugin world helpers without Electron imports, shared by native/worlds.ts and native/core/registry.ts (and their tests)
import type { LunaWorldBundle } from "../build/plugins/lunaWorldPlugin";

/** Names of world natives in the registry, the permission store and window, so they never share a record with page-registered code */
export const worldFilePrefix = "world:";

/** What `<plugin>.world.json` must look like before the main process runs any of it */
export const isBundle = (value: unknown): value is LunaWorldBundle =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as LunaWorldBundle).code === "string" &&
	typeof (value as LunaWorldBundle).natives === "object" &&
	(value as LunaWorldBundle).natives !== null &&
	!Array.isArray((value as LunaWorldBundle).natives) &&
	Object.values((value as LunaWorldBundle).natives).every((code) => typeof code === "string");

/** Parses `<plugin>.world.json`, throws if it isn't a world bundle */
export const parseBundle = (text: string): LunaWorldBundle => {
	const bundle: unknown = JSON.parse(text);
	if (!isBundle(bundle)) throw new Error("[Luna.worlds] Not a world bundle");
	return bundle;
};
