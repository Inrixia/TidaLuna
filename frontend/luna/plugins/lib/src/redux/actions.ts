import type { MaybePromise, VoidLike } from "@inrixia/helpers";
import type { ActionType } from "./types/actions/actionTypes";

import { buildActions, reduxStore } from "@luna/core";
import type { ActionPayloads } from "./types";

export type LunaActions = {
	[K in ActionType]: (payload: ActionPayloads[K]) => MaybePromise<VoidLike>;
};

export const actions: LunaActions = <LunaActions>{};
for (const [name, buildAction] of Object.entries(buildActions)) {
	actions[name as keyof LunaActions] = (...args: any[]) => reduxStore.dispatch(buildAction(...args));
}
