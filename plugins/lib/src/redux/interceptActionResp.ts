import { Semaphore } from "@inrixia/helpers";

import { unloadSet, type LunaUnload, type LunaUnloads } from "@luna/core";

import { safeTimeout } from "../helpers";
import { interceptPromise, type InterceptPayload } from "./intercept";
import type { ActionType } from "./types";

const intercepts: Record<ActionType, Semaphore> = {} as Record<ActionType, Semaphore>;

/**
 * Nothing answered within the timeout. It is an Error rather than a string so a caller can tell "TIDAL never replied" from
 * a rejection action's payload, which is a real answer: one is worth retrying, the other is not.
 */
export class InterceptTimeoutError extends Error {
	public constructor(resActionTypes: ActionType[], rejActionTypes?: ActionType[]) {
		super(`[interceptActionResp.TIMEOUT] ${JSON.stringify([resActionTypes, rejActionTypes])}`);
		this.name = "InterceptTimeoutError";
	}
}

/**
 * @param trigger Function called after intercepters setup.
 * @param resActionTypes Array of action types to resolve on
 * @param rejActionTypes Array of action types to reject on
 * @param unloads Set of unload functions to add this to, can be null but only pass if you know
 * @param options Options allowing configuring timeoutMs (default 5s) and if the actions intercepted should be cancelled.
 * @returns A promise that resolves on resActionTypes or rejects on rejActionTypes
 */
export const interceptActionResp = async <RESAT extends ActionType, REJAT extends ActionType, RES extends InterceptPayload<RESAT>>(
	trigger: Function,
	unloads: LunaUnloads,
	resActionTypes: RESAT[],
	rejActionTypes?: REJAT[],
	{ timeoutMs, cancel }: { timeoutMs?: number; cancel?: true } = {},
): Promise<RES> => {
	const _unloads = new Set<LunaUnload>();
	// Lock calls to interceptPromise based on the first action type to avoid race conditions.
	// This obtains the semaphore for the given type or creates it if it doesn't exist.
	_unloads.add(await (intercepts[resActionTypes[0]] ??= new Semaphore(1)).obtain());

	timeoutMs ??= 5000;

	const resPromises = resActionTypes.map((type) => interceptPromise(type, _unloads, cancel));
	// interceptPromise resolves the payload of whichever action it intercepts, so a rejection action has to be turned into
	// a rejection here: this promise rejects on rejActionTypes, as its signature and docs say
	const rejPromises =
		rejActionTypes?.map((type) =>
			interceptPromise(type, _unloads, cancel).then((payload) => {
				throw payload;
			}),
		) ?? [];
	const rejTimeout = new Promise<never>((_, rej) =>
		safeTimeout(_unloads, () => rej(new InterceptTimeoutError(resActionTypes, rejActionTypes)), timeoutMs),
	);
	// We dont worry about removing from _unloads as all unloads here are idempotent
	if (unloads !== null) {
		for (const unload of _unloads) unloads.add(unload);
	}
	const promise = Promise.race([...resPromises, ...rejPromises, rejTimeout]).finally(() => unloadSet(_unloads));
	// Queue our action to the eventLoop
	setTimeout(trigger);
	return promise as Promise<RES>;
};
