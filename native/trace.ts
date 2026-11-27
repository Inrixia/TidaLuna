import { createLogger } from "../render/src/trace/createLogger";

/** The main process counterpart of the page's `Tracer` (render/src/trace), without `msg` as there is no page to show messages in */
export const NativeTracer = (source: string) => ({
	withSource: (newSource: string) => NativeTracer(source + newSource),
	log: createLogger(source, console.log),
	warn: createLogger(source, console.warn),
	err: createLogger(source, console.error),
	debug: createLogger(source, console.debug),
});
export type NativeTracer = ReturnType<typeof NativeTracer>;

export const nativeTrace = NativeTracer("[Luna.native]");
