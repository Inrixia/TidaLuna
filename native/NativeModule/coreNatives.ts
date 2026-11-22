import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// Written by build/buildPlugins.ts next to injector.mjs: sha256 of the native code of Luna's own core plugins.
// Read from the injector's own folder, not TIDALUNA_DIST_PATH, so a changed dist path can't bring its own list.
const listPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "luna.natives.json");

/** Whether `hash` is the hash of one of Luna's own core native modules, built together with this injector */
export const isCoreNative = async (hash: string): Promise<boolean> => {
	try {
		// Read on every registration (rare) so a watch rebuild's new hashes apply
		const hashes: unknown = JSON.parse(await readFile(listPath, "utf8"));
		return Array.isArray(hashes) && hashes.includes(hash);
	} catch {
		return false;
	}
};
