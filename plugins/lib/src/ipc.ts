import type { AnyFn } from "@inrixia/helpers";
import type { LunaUnloads } from "@luna/core";

export const invoke = __ipcRenderer.invoke;
export const send = __ipcRenderer.send;
export const on = (unloads: LunaUnloads, channel: string, listener: AnyFn) => {
	const unload = __ipcRenderer.on(channel, listener);
	unloads.add(unload);
	return unload;
};
export const once = (unloads: LunaUnloads, channel: string, listener: AnyFn) => {
	const unload = __ipcRenderer.once(channel, listener);
	unloads.add(unload);
	return unload;
};
export const onOpenUrl = (unloads: LunaUnloads, listener: (url: string) => any) => on(unloads, "__Luna.openUrl", listener);
