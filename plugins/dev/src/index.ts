import { ReactiveStore, Tracer, type LunaUnload } from "@luna/core";
import { startReduxLog, stopReduxLog } from "./interceptActions";
import { startNativeIPCLog, stopNativeIPCLog } from "./ipc";
import { startRenderIpcLog, stopRenderIpcLog } from "./ipc.native";

export const { trace, errSignal } = Tracer("[DevTools]");

export const unloads = new Set<LunaUnload>();
unloads.add(stopNativeIPCLog);
unloads.add(stopRenderIpcLog);
unloads.add(stopReduxLog);

export const storage = await ReactiveStore.getPluginStorage("DevTools", {
	logIPCFromNative: false,
	logIPCFromRender: false,
	logReduxEvents: false,
	logInterceptsRegex: ".*",
});

if (storage.logIPCFromNative) startNativeIPCLog().catch(trace.err.withContext("Failed to start native IPC logging").throw);
if (storage.logIPCFromRender) startRenderIpcLog().catch(trace.err.withContext("Failed to start render IPC logging").throw);
if (storage.logReduxEvents)
	startReduxLog(new RegExp(storage.logInterceptsRegex || ".*"), trace.log.withContext("(Redux)")).catch(
		trace.err.withContext("Failed to start redux event logging").throw,
	);

export { Settings } from "./Settings";

export { getNativeIPCEvents, getRenderIPCEvents } from "./ipc.native";

export { startNativeDebugging } from "./debug.native";
export { startNativeIPCLog, stopNativeIPCLog } from "./ipc";
export { startRenderIpcLog, stopRenderIpcLog } from "./ipc.native";
