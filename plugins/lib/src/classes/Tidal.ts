import { objectify } from "@inrixia/helpers";
import { redux } from "..";
import { PlayState } from "./PlayState";

export class Tidal {
	public static readonly PlayState = PlayState;
	public static get featureFlags() {
		const { flags, userOverrides } = redux.store.getState().featureFlags;

		const featureFlags = objectify(flags);
		for (const key in userOverrides) {
			featureFlags[key].value = userOverrides[key];
		}
		return featureFlags;
	}
}
