import type { AudioQuality } from "./content";

export interface UserClient {
	id: number;
	name: string;
	application: {
		name: string;
		type: {
			name: string;
		};
		service: string;
	};
	uniqueKey: string;
	authorizedForOffline: true;
	/** @example "2023-08-03T10:29:24.094+0000" */
	authorizedForOfflineDate: string;
	/** @example "2025-01-17T04:58:09.374+0000" */
	lastLogin: string;
	/** @example "2023-03-24T09:46:35.581+0000" */
	created: string;
	numberOfOfflineAlbums: number;
	numberOfOfflinePlaylists: number;
}
export interface UserMeta {
	id: number;
	username: `${string}@${string}`;
	profileName: string;
	firstName?: string | null;
	lastName?: string | null;
	email: `${string}@${string}`;
	emailVerified: boolean;
	countryCode: string;
	/** @example "2018-03-30T00:21:32.615+0000" */
	created: string;
	newsletter: boolean;
	acceptedEULA: boolean;
	dateOfBirth?: string | null;
	facebookUid: number;
	appleUid?: string | null;
	parentId: number;
	partner: number;
	tidalId?: string | null;
	earlyAccessProgram: boolean;
	yearOfBirth?: string | null;
	nostrPublicKey?: string | null;
	artistId?: string | null;
}

export type OnboardingStep =
	| "ADD_TO_FAVORITES"
	| "ADD_TO_OFFLINE"
	| "ADD_TO_PLAYLIST"
	| "ALBUM_INFO"
	| "ARTIST_CREDITS"
	| "ARTIST_PICKER"
	| "BLOCK"
	| "BOTTOM_NAVIGATION_INTRO"
	| "CAST"
	| "CAST2"
	| "CONTRIBUTOR"
	| "DOLBY_ATMOS"
	| "LYRICS"
	| "MENU_MY_MUSIC"
	| "MENU_OFFLINE_CONTENT"
	| "migrated"
	| "OPTIONS_MENU"
	| "PLAY_QUEUE_BUTTON"
	| "PLAY_QUEUE_SUGGESTIONS"
	| "PLAY_QUEUE"
	| "RELOCATION_SETTINGS"
	| "SETTINGS"
	| "SPRINT_REDESIGN_UPDATE"
	| "USER_PROFILE_ONBOARDED"
	| "WEB_3.0.0_UPDATE";
export interface UserOnboarding {
	error: unknown;
	loaded: boolean;
	stepsShown: OnboardingStep[];
}

export interface UserSubscription {
	/** @example "2022-09-23T04:52:14.568+0000" */
	startDate: string;
	/** @example "2025-06-09T04:52:11.406+0000" */
	validUntil: string;
	status: string;
	subscription: {
		type: string;
		offlineGracePeriod: number;
	};
	highestSoundQuality: AudioQuality;
	premiumAccess: boolean;
	canGetTrial: boolean;
	paymentType: string;
	paymentOverdue: boolean;
}
export interface User {
	clients: UserClient[];
	isLoaded: boolean;
	isLoading: boolean;
	meta: UserMeta;
	onboarding: UserOnboarding;
	subscription: UserSubscription;
	temporaryDisableArtistPicker: boolean;
}
