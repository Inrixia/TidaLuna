import { buildActions, unloadSet, type LunaUnload } from "@luna/core";

import { redux } from "@luna/lib";

const unloads = new Set<LunaUnload>();
export const startReduxLog = async (actionPath: RegExp, handler: redux.InterceptCallback<redux.ActionType>) => {
	const actionTypes = Object.keys(buildActions).filter((actionType) => actionPath.test(actionType)) as redux.ActionType[];
	redux.intercept(actionTypes, unloads, handler);
};
export const stopReduxLog = async () => unloadSet(unloads);
