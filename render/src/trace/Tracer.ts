import { Signal } from "@inrixia/helpers";
import { createLogger, type LogConsumer } from "./createLogger";
import { Messager } from "./Messager";

/**
 * @param source Prefixed to every log
 * @param errSignal Optional, Set to console.err args (excluding source prefix) when .err called
 * @example
 * const { trace, errSignal } = Tracer("[myPlugin]");
 * // Export errSignal for @luna/ui to show error messages (assuming we are a plugin)
 * export { errSignal };
 *
 * // Log error with context then throw it
 * await someFunc().catch(trace.err.withContext("someFunc failed").throw);
 *
 * // Log error & show message with context then throw it
 * await someFunc().catch(trace.msg.err.withContext("someFunc failed").throw);
 */
export const Tracer = (source: string, errSignal: Signal<string | undefined> | null = new Signal(undefined)) => {
	let errConsumer: LogConsumer;
	if (errSignal !== undefined && errSignal !== null) {
		errConsumer = (source, ...args) => {
			console.error(source, ...args);
			errSignal._ = args
				.map((arg) => {
					if (arg instanceof Error) return arg.message;
					if (typeof arg === "object") return "";
					return String(arg);
				})
				.join(" ");
		};
	} else errConsumer = console.error;

	return {
		trace: {
			withSource: (newSource: string) => Tracer(source + newSource, errSignal),
			log: createLogger(source, console.log),
			warn: createLogger(source, console.warn),
			err: createLogger(source, errConsumer),
			debug: createLogger(source, console.debug),
			msg: {
				log: createLogger(source, (...data) => {
					Messager.Info(...data);
					return console.log(...data);
				}),
				warn: createLogger(source, (...data) => {
					Messager.Warn(...data);
					return console.warn(...data);
				}),
				err: createLogger(source, (...data) => {
					Messager.Error(...data);
					return errConsumer(...data);
				}),
			},
		},
		errSignal,
	};
};
export type Tracer = ReturnType<typeof Tracer>["trace"];

export const coreTrace = Tracer("[@luna/core]", null).trace;
