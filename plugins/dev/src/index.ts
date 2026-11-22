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

// The filter is saved as it is typed, so what is stored may not compile. That must not stop the plugin loading
export const interceptsRegex = (): RegExp => {
	try {
		return new RegExp(storage.logInterceptsRegex || ".*");
	} catch {
		trace.msg.warn(`Invalid event regex filter "${storage.logInterceptsRegex}", logging all events`);
		return /.*/;
	}
};

if (storage.logIPCFromNative) startNativeIPCLog().catch(trace.err.withContext("Failed to start native IPC logging").throw);
if (storage.logIPCFromRender) startRenderIpcLog().catch(trace.err.withContext("Failed to start render IPC logging").throw);
if (storage.logReduxEvents)
	startReduxLog(interceptsRegex(), trace.log.withContext("(Redux)")).catch(
		trace.err.withContext("Failed to start redux event logging").throw,
	);

export { Settings } from "./Settings";

export { getNativeIPCEvents, getRenderIPCEvents } from "./ipc.native";

export { startNativeDebugging } from "./debug.native";
export { startNativeIPCLog, stopNativeIPCLog } from "./ipc";
export { startRenderIpcLog, stopRenderIpcLog } from "./ipc.native";
