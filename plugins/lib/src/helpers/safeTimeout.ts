import type { LunaUnload, LunaUnloads } from "@luna/core";

// Removed from unloads once fired or cancelled, so debounced callers (cancel and set again) don't pile up entries
export const safeTimeout = (unloads: LunaUnloads, cb: () => void, delay?: number): LunaUnload => {
	const timeout = setTimeout(() => {
		unloads?.delete(unload);
		cb();
	}, delay);
	const unload: LunaUnload = () => {
		clearTimeout(timeout);
		unloads?.delete(unload);
	};
	unloads?.add(unload);
	unload.source = "safeTimeout";
	return unload;
};

export const safeInterval = (unloads: LunaUnloads, cb: () => void, delay?: number): LunaUnload => {
	const interval = setInterval(cb, delay);
	const unload: LunaUnload = () => {
		clearInterval(interval);
		unloads?.delete(unload);
	};
	unloads?.add(unload);
	unload.source = "safeInterval";
	return unload;
};
