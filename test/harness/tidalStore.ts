import { createStore, type Store } from "redux";
import type { TidalStoreState } from "../../plugins/lib/src/redux/types/store";

/**
 * The slices of TIDAL's store that Luna's code reads. Tests patch what they need with `setTidalState`.
 */
export const defaultTidalState = () => ({
	content: {},
	playlists: {},
	albums: {},
	artists: {},
	tracks: {},
	videos: {},
	session: { userId: "1", countryCode: "US" },
	locale: { currentBundleName: "en-US" },
	router: { currentPath: "/" },
	playbackControls: {
		playbackContext: undefined,
		playbackState: "IDLE",
		desiredPlaybackState: "IDLE",
		latestCurrentTime: 0,
	},
	playQueue: { elements: [], currentIndex: -1, shuffleModeEnabled: false, repeatMode: 0 },
	tidalOpenPlatformApi: { queries: {} },
	entities: {},
	etag: {},
});

export type TidalState = ReturnType<typeof defaultTidalState>;

export const SET_STATE = "__luna/test-set-state";

export const createTidalStore = (initial: Partial<TidalState> = {}): Store<TidalState> =>
	createStore((state = { ...defaultTidalState(), ...initial } as TidalState, action: { type?: string; patch?: Partial<TidalState> }) =>
		action?.type === SET_STATE && action.patch !== undefined ? { ...state, ...action.patch } : state,
	);

export const reduxStore = createTidalStore();

/** Patch slices of the fake TIDAL store, shallow like the reducer */
export const setTidalState = (patch: Partial<TidalState>) => reduxStore.dispatch({ type: SET_STATE, patch });

/** Back to a default store between tests */
export const resetTidalState = () => setTidalState(defaultTidalState());

/** Typed view for code that expects TIDAL's own store type */
export const tidalStore = reduxStore as unknown as Store<TidalStoreState>;
