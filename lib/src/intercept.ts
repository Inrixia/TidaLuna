import type { ActionType } from "./actionTypes";
import type { LunaUnload } from "./unloads";

import { type OActionPayloads, interceptors } from "./window.luna";

export type InterceptCallback<P extends unknown> = (payload: P, ...args: unknown[]) => true | unknown;

export function intercept<T extends Extract<keyof OActionPayloads, ActionType>>(
	type: T,
	cb: InterceptCallback<OActionPayloads[T]>,
	once?: boolean,
): void;
export function intercept<V, T extends string = string>(type: T, cb: InterceptCallback<V>, once?: boolean): void;
/**
 * Intercept a Redux action based on its `type`
 * @param type The ActionKey to intercept
 * @param cb Called when action is intercepted with action args, if returning true action is not dispatched (cancelled)
 * @param once If set true only intercepts once
 * @returns Function to call to unload/cancel the intercept
 */
export function intercept<P extends unknown, T extends ActionType>(type: T, cb: InterceptCallback<P>, once?: boolean): LunaUnload {
	interceptors[type] ??= new Set<InterceptCallback<unknown>>();
	// If once is true then call unIntercept immediately to only run once
	const intercept = once
		? (...args: [P, ...unknown[]]) => {
				unIntercept();
				return cb(...args);
			}
		: cb;
	// Wrap removing the callback from the interceptors in a unload function and return it
	const unIntercept = () => {
		interceptors[type].delete(intercept);
		if (interceptors[type].size === 0) delete interceptors[type];
	};
	interceptors[type].add(intercept);
	return unIntercept;
}
