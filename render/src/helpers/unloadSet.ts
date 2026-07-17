import type { NullishUnloadFnSet, UnloadFn, UnloadFnSet } from "@inrixia/helpers";
import { coreTrace } from "../trace";

export type LunaUnload = UnloadFn;
export type LunaUnloads = UnloadFnSet;
export type NullishLunaUnloads = NullishUnloadFnSet;

export const unloadSet = async (unloads?: NullishLunaUnloads): Promise<void> => {
	if (unloads === undefined || unloads === null || unloads.size === 0) return;
	const toUnload: LunaUnload[] = [];
	for (const unload of unloads) toUnload.push(unload);

	await Promise.all(
		toUnload.map(async (unload) => {
			try {
				// Give each unload 5s to run before timing out so we dont deadlock
				await Promise.race([unload(), new Promise((_, rej) => setTimeout(() => rej(new Error("Unload took longer than 5s to run...")), 5000))]);
			} catch (err) {
				coreTrace.msg.err.withContext(`Error unloading ${unload.source ?? ""}.${unload.name}`)(err);
			}
		}),
	);

	// Clear unloads after called to ensure their never called again
	unloads.clear();
};
