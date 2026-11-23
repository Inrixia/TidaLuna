import { getStore } from "./permissions/store";

export { worldFilePrefix } from "../worldBundle";

// Hashes of native code loaded for plugin worlds since start (also ones refused or still asking)
const loaded = new Set<string>();
export const markWorldNative = (nativeHash: string) => void loaded.add(nativeHash);

/** Native code of a plugin world, which page code may not register (see NativeModule/index.ts registerNative) */
export const isWorldNative = (hash: string) =>
	loaded.has(hash) || Object.values(getStore().natives).some((record) => record.nativeHashes?.includes(hash) === true);
