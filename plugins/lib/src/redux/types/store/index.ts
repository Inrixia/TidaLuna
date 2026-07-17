import type { AudioQuality, Content } from "./content";
import type { Notification } from "./Notification";
import type { AccumulatedPlaybackTime, PlaybackControls } from "./Playback";
import type { CloudQueue, PlayQueue } from "./PlayQueue";
import type { RemotePlayback } from "./RemotePlayback";
import type { SelectionState } from "./SelectionItem";
import type { User } from "./User";
import type { UserProfile } from "./UserProfile";

export * from "../actions/ContextMenu";
export * from "../actions/MediaCollection";
export * from "./content";
export * from "./Lyrics";
export * from "./Notification";
export * from "./Playback";
export * from "./PlayQueue";
export * from "./RemotePlayback";
export * from "./SelectionItem";
export * from "./User";
export * from "./UserProfile";

export type ItemId = string | number;

// #region TidalStoreState
export interface TidalStoreState {
	accumulatedPlaybackTime: AccumulatedPlaybackTime;
	activePlayer: ActivePlayer;
	artistPicker: ArtistPicker;
	auth: Auth;
	cloudQueue: CloudQueue;
	content: Content;
	etag: Record<string, string>;
	experimentationPlatform: ExperimentationPlatform;
	favorites: Favorites;
	featureFlags: FeatureFlags;
	feed: Feed;
	locale: Locale;
	network: Network;
	notifications: {
		notifications: Notification[];
	};
	playQueue: PlayQueue;
	playbackControls: PlaybackControls;
	player: Player;
	router: Router;
	search: Search;
	session: SessionState;
	selections: SelectionState;
	settings: SettingsState;
	user: User;
	userProfiles: Record<string, UserProfile>;
	view: View;
	remotePlayback: RemotePlayback;
	speech: Speech;
}
// #endregion

// #region ActivePlayer
export interface ActivePlayer {
	activePlayer: ActivePlayerType;
	currentStreamingSessionId?: string | null;
}

export type ActivePlayerType = "PLAYER_SDK" | "WEBPLAYER" | "EXTERNAL_PLAYER";
// #endregion

// #region ArtistPicker
export interface ArtistPicker {
	alreadyFetchedArtists: unknown;
	categories: ArtistPickerCategory[];
	isLoading: boolean;
	searchAsideShowing: boolean;
	searchPhrase: string;
	searchResults: unknown[];
	selected: unknown[];
}

export interface ArtistPickerCategory {
	artists: unknown[];
	id: string;
	name: string;
}
// #endregion

// #region Auth
export interface Auth {
	verificationUri: string;
}
// #endregion

// #region ExperimentationPlatform
export type Experiments = Record<string, string>;
export interface ExperimentationPlatform {
	activeExperiments: Experiments;
	anonymousExperiments: Experiments;
	authenticatedExperiments: Experiments;
	experimentKeys: Experiments;
}
// #endregion

// #region Favorites
export interface Favorites {
	albums: number[];
	artists: number[];
	mixes: string[];
	playlists: string[];
	tracks: number[];
	users: string[];
	videos: number[];
}
// #endregion

// #region FeatureFlags
export interface FeatureFlag<K extends string = string> {
	created: number;
	name: K;
	type: "BOOLEAN";
	value: boolean;
}
export type FeatureFlagSet = { [K in string]: FeatureFlag<K> };
export interface FeatureFlags {
	ready: boolean;
	userOverrides: { [K in string]: boolean };
	flags: FeatureFlagSet;
}
// #endregion

// #region Feed
export interface Feed {
	hasNewFeedItems: boolean;
	status: string;
	updates: unknown[];
}
// #endregion

// #region Locale
export interface LocaleBundle {
	/** @example "English" */
	name: string;
	i18n: Record<string, string>;
}
export interface Locale {
	bundles: Record<string, LocaleBundle>;
	/** @example "en-us" */
	currentBundleName: string;
}
// #endregion

// #region Network
export interface Network {
	failedStartup: boolean;
	hasNetworkConnection: boolean;
}
// #endregion

// #region Router
export interface Router {
	currentParams: Record<string, string>;
	currentPath: string;
	previousPath: string;
	search: string;
}
// #endregion

// #region Search
export interface RecentSearch {
	created: number;
	id: string;
	kind: "albums" | "artists" | "genres" | "playlists" | "search" | "tracks" | "userProfiles" | "videos";
	text: string;
}
export interface Search {
	didYouMeanByQueryMap: unknown;
	genres: unknown;
	isLoading: boolean;
	queryId: string;
	recentSearches: RecentSearch[];
	searchPhrase: string;
	searchResultFilterOrder: ["TRACKS", "VIDEOS", "ARTISTS", "ALBUMS", "PLAYLISTS", "UPLOADS", "USERPROFILES"];
	searchSession: {
		lastUpdated: number;
		triggerNewSession: boolean;
		uuid: string;
	};
	suggestionUuid: string;
	topHit: unknown;
}
// #endregion

// #region Session
export interface SessionState {
	clientId: string;
	clientUniqueKey: string;
	countryCode: string;
	facebookAccessToken?: string | null;
	isInitialized: boolean;
	isLoading: boolean;
	isPolling: boolean;
	userId: number;
	utmParameters: {
		banner: string;
		campaign: string;
		content: string;
		medium: string;
		source: string;
	};
	migrated: boolean;
}
// #endregion

// #region Settings
export interface SettingsState {
	audioNormalization: "NONE" | "ALBUM" | "TRACK";
	audioSpectrumEnabled: boolean;
	autoPlay: boolean;
	desktop: {
		autoStartMode: 0 | 1;
		closeToTray: boolean;
	};
	explicitContentEnabled: boolean;
	language: string;
	openLinksInDesktopApp: boolean;
	quality: {
		streaming: AudioQuality;
	};
	updateAvailable: boolean;
	urls: {
		accessibility: "https://tidal.com/accessibility";
		betaParticipationAgreement: "https://tidal.com/beta-participation-agreement";
		earlyAccess: "https://tidal.com/early-access";
		privacy: "https://tidal.com/privacy";
		support: "https://support.tidal.com";
		terms: "https://tidal.com/terms";
	};
}
// #endregion

// #region View
export interface View {
	appReady: boolean;
	isDragging: boolean;
	isFeedSidebarShowing: boolean;
	isFullscreen: boolean;
	isNativeFullscreen: boolean;
	isNowPlaying: boolean;
	isPortal: boolean;
	isSearchPopoverShowing: boolean;
	modules: unknown;
	showNowPlaying: boolean;
	showPlayQueueAside: boolean;
	triggerSearchFocus: number;
}
// #endregion

// #region Speech
export interface Speech {
	command: unknown;
	recognitionActive: boolean;
	recognitionSupported: boolean;
}
// #endregion

// #region Player
export interface PlayerAvailableDevice {
	controllableVolume: boolean;
	id: string;
	name: string;
	nativeDeviceId: string;
	type?: string;
	webDeviceId: string;
}
export type PlayerDeviceMode = "exclusive" | "shared";
export interface Player {
	activeDeviceId: string;
	activeDeviceMode: PlayerDeviceMode;
	availableDevices: PlayerAvailableDevice[];
	desiredDeviceMode: Record<string, string>;
	forceVolume: Record<string, boolean>;
	hasPreloadedNextProduct: boolean;
}
// #endregion
