// @ts-expect-error Idk why TS thinks this module doesnt exist
import { after } from "spitroast";

import { logErr } from "../helpers/console.js";

export const buildActions: Record<string, Function> = {};
export const interceptors: Record<string, Set<Function>> = {};

const patchAction = (_Obj: { _: Function }) => {
	after("_", _Obj, ([type], buildAction) => {
		// There can be multiple buildActions for the same type.
		// But it seems they may just be duplicates so safe to override
		buildActions[type] = buildAction;

		// We proxy all of them anyway
		return new Proxy(buildAction, {
			// Intercept function call
			apply(orig, ctxt, args: [unknown, ...unknown[]]) {
				let shouldDispatch = true;

				const interceptorsSet = interceptors[type];
				if (interceptorsSet?.size > 0) {
					const onCeptErr = (...args) => logErr(`Error in ${type} interceptor`, ...args);
					// Call interceptorSet's callbacks with the args, dont dispatch if any return true
					for (const interceptor of interceptorsSet) {
						try {
							const result = interceptor(...args);
							if (result === true) shouldDispatch = false;
							else if (result instanceof Promise) result.catch(onCeptErr);
						} catch (err) {
							onCeptErr(err);
						}
					}
				}
				return shouldDispatch ? orig.apply(ctxt, args) : { type: "NOOP" };
			},
		});
	});
	return _Obj;
};

declare global {
	interface Window {
		patchAction: typeof patchAction;
	}
}
window.patchAction = patchAction;
