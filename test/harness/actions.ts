import type { ActionType } from "../../plugins/lib/src/redux/types/actions/actionTypes";
import { actions } from "../../plugins/lib/src/redux/actions";

/**
 * The redux actions Luna dispatches are built by TIDAL and copied into `actions` once, at import
 * (see test/setup-dom.ts). This overrides one for a test, e.g. to assert what a method dispatched.
 */
export const mockAction = <T extends string>(type: T, impl: (...args: any[]) => unknown) => {
	(actions as Record<string, unknown>)[type] = impl;
};

/** Every action type that Luna's own code dispatches */
export type LunaActionType = ActionType;
