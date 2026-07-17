import { reduxStore } from "@luna/core";
import type { TidalStoreState } from "./types/store";

import type { Store } from "redux";

export const store: Store<TidalStoreState> = reduxStore;
