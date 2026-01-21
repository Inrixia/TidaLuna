import { unloadSet, type LunaUnloads } from "@luna/core";
import { ipcRenderer } from "@luna/lib";
import { trace } from ".";
import { getNativeIPCEvents } from "./ipc.native";

const ipcUnloads: LunaUnloads = new Set();
export const startNativeIPCLog = async () => {
	for (const eventName of Object.values(await getNativeIPCEvents())) {
		ipcRenderer.on(ipcUnloads, eventName, (...args) => trace.log("Native -> Render", eventName, ...args));
	}
};
export const stopNativeIPCLog = () => unloadSet(ipcUnloads);
