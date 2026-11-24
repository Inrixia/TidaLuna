import { Signal } from "@inrixia/helpers";
import { createLogger, type LogConsumer } from "../../render/src/trace/createLogger";

/**
 * In tests Luna's core exposes this instead of `render/src/index.ts`, which boots TIDAL (top level await on its scripts).
 * Everything that can be imported without booting TIDAL is the real implementation; only the TIDAL-facing pieces are faked.
 * `render/src/index.ts`'s runtime exports are all covered here, see test/harness/core.parity.test.ts.
 */

const noopMessager = { Info: () => {}, Warn: () => {}, Error: () => {} };

/** Same shape as the real Tracer, but `.msg.*` doesn't dispatch to TIDAL's redux store */
export const Tracer = (source: string, errSignal: Signal<string | undefined> | null = new Signal(undefined)) => {
	const errConsumer: LogConsumer = (from, ...args) => {
		console.error(from, ...args);
		if (errSignal !== undefined && errSignal !== null) {
			errSignal._ = args
				.map((arg) => {
					if (arg instanceof Error) return arg.message;
					if (typeof arg === "object") return "";
					return String(arg);
				})
				.join(" ");
		}
	};

	return {
		trace: {
			withSource: (newSource: string) => Tracer(source + newSource, errSignal),
			log: createLogger(source, console.log),
			warn: createLogger(source, console.warn),
			err: createLogger(source, errConsumer),
			debug: createLogger(source, console.debug),
			msg: {
				log: createLogger(source, (...data: any[]) => {
					noopMessager.Info();
					return console.log(...data);
				}),
				warn: createLogger(source, (...data: any[]) => {
					noopMessager.Warn();
					return console.warn(...data);
				}),
				err: createLogger(source, (...data: any[]) => {
					noopMessager.Error();
					return errConsumer(...data);
				}),
			},
		},
		errSignal,
	};
};
export type Tracer = ReturnType<typeof Tracer>["trace"];

export const coreTrace = Tracer("[@luna/core]", null).trace;

/** Luna shows these in TIDAL, tests only need the calls not to touch TIDAL's store */
export class Messager {
	public static Info() {}
	public static Warn() {}
	public static Error() {}
}

// Real implementations, none of these import the TIDAL boot code
export { requestCache, type RequestCacheRule } from "../../render/src/requestCache";
export { tidalModules } from "../../render/src/tidalModules";
export { cspReports, cspReportsDropped, type CspReport } from "../../render/src/cspReports";
export { buildActions, interceptors } from "../../render/src/exposeTidalInternals.patchAction";
export * as ftch from "../../render/src/helpers/fetch";
export { findModuleByProperty, findModuleProperty, recursiveSearch } from "../../render/src/helpers/findModule";
export { unloadSet, type LunaUnload, type LunaUnloads, type NullishLunaUnloads } from "../../render/src/helpers/unloadSet";
export { ReactiveStore } from "../../render/src/ReactiveStore";
// SettingsTransfer is deliberately not re-exported: it imports render/src/LunaPlugin.ts, which loads boot code
// (nativeScrollbars.ts and friends). Its own test mocks that import.
export type { ExportData } from "../../render/src/SettingsTransfer";

// Fakes. `reduxStore` is a real redux store shaped like TIDAL's, `modules` is what TIDAL's chunks would register
export { reduxStore, setTidalState, resetTidalState, createTidalStore, defaultTidalState, tidalStore } from "./tidalStore";
export { LunaPlugin } from "./lunaPlugin";
export const modules: Record<string, any> = {};
