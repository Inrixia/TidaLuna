import type { ActionPayloads } from "./types";
import type { ActionType } from "./types/actions/actionTypes";

export type InterceptPayload<T extends ActionType | ReadonlyArray<ActionType>> =
	T extends ReadonlyArray<infer U extends ActionType> // Check if T is an array, ensure U is ActionType
		? InterceptPayload<U> // If T is ActionType[], give a union of all payloads
		: T extends keyof ActionPayloads
			? ActionPayloads[T]
			: never;

export type InterceptCallback<T extends ActionType | ActionType[], P = InterceptPayload<T>> = (payload: P, type: ActionType) => true | unknown;
export type LunaInterceptors = {
	[K in ActionType]?: Set<InterceptCallback<K>>;
};

import { interceptors, type LunaUnload, type LunaUnloads } from "@luna/core";

/**
 * Intercept a Redux action based on its `type`
 * @param actionType The ActionKey to intercept
 * @param cb Called when action is intercepted with action args, if returning true action is not dispatched (cancelled)
 * @param unloads Set of unload functions to add this to, can be null but only pass if you know what your doing
 * @param once If set true only intercepts once
 * @returns Function to call to unload/cancel the intercept
 */
export function intercept<T extends ActionType>(actionType: T, unloads: LunaUnloads, cb: InterceptCallback<T>, once?: boolean): LunaUnload;
export function intercept<T extends ActionType[]>(actionType: T, unloads: LunaUnloads, cb: InterceptCallback<T>, once?: boolean): LunaUnload;
export function intercept<T extends ActionType | ActionType[]>(
	actionTypes: T,
	unloads: LunaUnloads,
	cb: InterceptCallback<T>,
	once?: boolean,
): LunaUnload {
	const actionTypeArray: ActionType[] = Array.isArray(actionTypes) ? actionTypes : [actionTypes];

	// If once is true then call unIntercept immediately to only run once
	const intercept = once
		? (payload: InterceptPayload<T>, type: ActionType) => {
				unIntercept();
				return cb(payload, type);
			}
		: cb;

	// Wrap removing the callback from the interceptors in a unload function and return it
	const unIntercept = () => {
		for (const actionType of actionTypeArray) {
			// ?. so that it doesn't throw if the interceptor was already removed
			interceptors[actionType]?.delete(intercept);
			if (interceptors[actionType]?.size === 0) delete interceptors[actionType];
		}
	};
	unIntercept.source = `intercept${JSON.stringify(actionTypeArray)}`;

	for (const actionType of actionTypeArray) {
		interceptors[actionType] ??= new Set<InterceptCallback<T>>();
		interceptors[actionType].add(intercept);
	}

	unloads?.add(unIntercept);
	return unIntercept;
}

/**
 * Intercept a Redux action based on its `type`
 * @param actionType The ActionKey to intercept
 * @param unloads Set of unload functions to add this to, can be null but only pass if you know what your doing
 * @param cancel If set true the action is not dispatched (cancelled)
 * @returns A promise that resolves with the action payload when the action is intercepted
 */
export function interceptPromise<T extends ActionType>(actionType: T, unloads: LunaUnloads, cancel?: true): Promise<InterceptPayload<T>>;
export function interceptPromise<T extends ActionType>(actionType: T, unloads: LunaUnloads, cancel?: true): Promise<InterceptPayload<T>> {
	const { resolve, promise } = Promise.withResolvers<InterceptPayload<T>>();
	intercept(
		actionType,
		unloads,
		(payload) => {
			resolve(payload);
			return cancel;
		},
		true,
	);
	return promise;
}
