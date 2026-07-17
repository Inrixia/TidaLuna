import type { FolderItemList } from "neptune-types/tidal";
import type {
	Album,
	Artist,
	ArtistBio,
	ArtistInline,
	BlockItemContextMenu,
	CloudQueue,
	CloudQueueAddItemMode,
	CloudQueueItem,
	ContentType,
	ContextMenu,
	EmptyFolderContextMenu,
	ExperimentationPlatform,
	Favorites,
	FeatureFlag,
	FeatureFlags,
	InputFieldClipboardContextMenu,
	ItemId,
	ItemType,
	LocaleBundle,
	Lyrics,
	MediaCollectionContext,
	MediaItem,
	MediaItemContextMenu,
	Message,
	MultiMediaItemContextMenu,
	OnboardingStep,
	PlaybackContext,
	PlaybackState,
	Player,
	Playlist,
	PlayQueueContext,
	PlayQueueElement,
	PlayQueuePosition,
	PlayQueuePriority,
	RecentSearch,
	RemotePlaybackDevice,
	RemotePlaybackDeviceType,
	RepeatMode,
	SelectionItem,
	SessionState,
	SettingsState,
	TidalConnectMediaInfo,
	TidalConnectQueueInfo,
	UserClient,
	UserMeta,
	UserProfile,
	UserProfileDataTypes,
	UserSubscription,
} from "../store";

import type { ActionType } from "./actionTypes";
import type { LoadFolderItemsPayload, LoadFolderItemsSuccess, LoadSpecificFolderItemsSuccess } from "./FolderItems";
import type { ItemsPageListType, List, ListType } from "./Lists";
import type { AddToPlaylistModal, ConfirmModal, CreateAiPlaylistModal, CreatePlaylistModal, PickItemModal } from "./Modal";
import type { CreatePlaylistPayload, PlaylistMeta } from "./Playlist";
import type { SearchResultPayload } from "./Search";
import type { SortDirection, SortOrder, StoredSortOrders } from "./SortOrders";
import type { BasePrompt } from "./TrackPrompts";

export type TrackListEntityType =
	| "album"
	| "albumList"
	| "articleList"
	| "artist"
	| "artist/toptracks"
	| "artistList"
	| "favoriteTracks"
	| "favoriteVideos"
	| "mix"
	| "mixList"
	| "other"
	| "pages"
	| "pages/contributor"
	| "playlist"
	| "playlistList"
	| "search"
	| "suggestedItemsForPlaylist"
	| "suggestions";

export type EventAction = "add" | "move" | "contextMenu";

// #endregion

// #region Credits
export interface CreditContributor {
	id?: number;
	name: string;
}
export interface Credit {
	contributors: CreditContributor[];
	type: string;
}
// #endregion

// #region Favorites
export interface LoadFavoriteMediaItem {
	orderBy?: SortOrder;
	orderDirection?: SortDirection | null;
	reset?: boolean | null;
}
// #endregion

// #region MediaProduct
export interface MediaProduct {
	productId: ItemId;
	productType: ContentType;
	referenceId?: string;
	sourceId?: string;
	sourceType?: string;
}
// #endregion

export * from "./actionTypes";
export interface ActionPayloads {
	ADD_ARTISTS_TO_CATEGORY: {
		artist: Artist;
		relatedArtists: Artist[];
	};
	ADD_ARTIST_FROM_SEARCH: {
		artist: Artist;
		relatedArtists: Artist[];
	};
	ADD_CATEGORIES: {
		categories: {
			category: {
				id: number;
				name: string;
			};
			pagedList: {
				items: Artist[];
			};
		}[];
	};
	ADD_RELATED_ARTIST: {
		artistIndex: number;
		categoryIndex: number;
		relatedArtists: Artist[];
	};
	ADD_TO_ALREADY_FETCHED_ARTISTS: string;
	CLEAR_SEARCH: void;
	HIDE_SEARCH_ASIDE: void;
	MOVE_MULTIPLE_MODAL_ITEMS_TO_FOLDER: {
		folderItemIds: ItemId[];
	};
	MOVE_SINGLE_MODAL_ITEM_TO_FOLDER: {
		folderId: ItemId;
	};
	SET_LOADING: boolean;
	SET_SEARCH_PHRASE: string;
	SET_SEARCH_RESULTS: {
		artists: Artist[];
	};
	SHOW_SEARCH_ASIDE: void;
	TOGGLE_ARTIST: {
		artistId: ItemId;
		trackingData: {
			contentId: ItemId;
			contentPlacement: number;
			contentSource: "originalContent" | "searchContent" | "showMore" | "similarContent";
			contentType: "artist";
			moduleId: string;
			placement: number;
			searchQuery?: string;
			ts: number;
		};
	};
	"__rtkq/focused": unknown;
	"__rtkq/offline": unknown;
	"__rtkq/online": unknown;
	"__rtkq/unfocused": unknown;
	"accumulatedPlaybackTime/CLEAR": string;
	"activePlayer/SET_ACTIVE_PLAYER": Player;

	// #region artistPicker
	"artistPicker/FINISH": void;
	"artistPicker/LOAD_CATEGORIES": void;
	"artistPicker/LOAD_MORE_ARTISTS": {
		categoryIndex: number;
	};
	"artistPicker/TOGGLE_ARTIST_FROM_CATEGORY": {
		artistIndex: number;
		categoryIndex: number;
	};
	"artistPicker/TOGGLE_ARTIST_FROM_SEARCH": {
		artistId: ItemId;
		index: number;
	};
	// #endregion

	// #region artists
	"artists/FAVORITE_ARTIST_ITEM": {
		artistId: ItemId;
	};
	"artists/LOAD_ARTIST_ITEMS": {
		cacheCheck?: boolean;
		context: "artist_folder" | "artist_root";
		contextId?: string;
		failSilently?: boolean | null;
		flatten?: boolean;
		includeOnly?: "" | "FAVORITE_ARTIST" | "FOLDER";
		loadAll?: boolean;
		reset?: boolean | null;
		sortDirection?: SortDirection;
		sortOrder?: SortOrder;
	};
	"artists/LOAD_ARTIST_ITEMS_SUCCESS": {
		artistItems: FolderItemList;
		context: "artist_folder" | "artist_root";
		contextId?: string;
		cursor?: string | null;
		eTag?: string | null;
		reset?: boolean | null;
		sortDirection: SortDirection;
		sortOrder?: SortOrder | null;
		totalNumberOfItems: number;
	};
	"artists/LOAD_SPECIFIC_ARTIST_ITEMS_SUCCESS": {
		artistItems: FolderItemList;
		cursor: string | null | undefined;
		eTag?: string | null;
		includeOnly: string;
		reset?: boolean | null;
		sortDirection: SortDirection;
		sortOrder: SortOrder | null | undefined;
		totalNumberOfItems: number;
	};
	"artists/REMOVE_ARTIST_ITEM": {
		itemType: string;
		removeFavorite?: boolean;
		trns: string[];
	};
	"artists/SET_ARTIST_FOLDER_STATE": {
		context: "artist_folder" | "artist_root";
		contextId: string;
	};
	"artists/TOGGLE_FAVORITES_IN_ARTIST": {
		itemId: number;
		itemType: unknown;
	};
	// #endregion

	// #region auth
	"auth/DEVICE_AUTH_CODE_EXPIRED": unknown;
	"auth/DEVICE_AUTH_CODE_RESPONSE_RECEIVED": unknown;
	"auth/LOGIN": void;
	// #endregion

	// #region block
	"block/UNBLOCK": void;
	"block/UNBLOCK_SUCCESS": {
		itemId: ItemId;
		itemType: ItemType;
	};
	// #endregion

	// #region blocks
	"blocks/ADD_ITEM_TO_BLOCK": {
		context: MediaCollectionContext;
		itemId: ItemId;
		itemType: ItemType;
	};
	"blocks/BLOCK": {
		context: MediaCollectionContext;
		itemId: ItemId;
		itemType: ItemType;
	};
	"blocks/CLEAR_ITEM_TO_BLOCK_ON_COMMIT": void;
	"blocks/CLEAR_ITEM_TO_BLOCK_ON_UNDO": void;
	"blocks/COMMIT_BLOCK": void;
	"blocks/COMMIT_BLOCK_FAIL": unknown;
	"blocks/COMMIT_BLOCK_SUCCESS": {
		context: MediaCollectionContext;
		itemId: ItemId;
		itemType: ItemType;
	};
	"blocks/HANDLE_CLEAR_ITEM_TO_BLOCK_ON_UNDO": void;
	"blocks/LOAD_BLOCKED_LIST": void;
	"blocks/LOAD_BLOCKED_LIST_SUCCESS": {
		etag: string;
		lists: {
			artists: ItemId[];
			tracks: ItemId[];
			users: ItemId[];
			videos: ItemId[];
		};
	};
	"blocks/LOAD_PERSISTENT_BLOCKED_LIST": {
		listType: ListType;
		reset?: boolean;
	};
	"blocks/LOAD_PERSISTENT_BLOCKED_LIST_FAIL": {
		error: string;
		listType: ListType;
	};
	"blocks/LOAD_PERSISTENT_BLOCKED_LIST_SUCCESS": List;
	// #endregion

	// #region chromeCast
	"chromeCast/API_AVAILABLE": {
		castState: unknown;
		sessionState: unknown;
	};
	"chromeCast/CAST_STATE_CHANGED": unknown;
	"chromeCast/CONNECTED": void;
	"chromeCast/DISCONNECTED": void;
	"chromeCast/REMOTE_PLAYER_CHANGED": unknown;
	"chromeCast/REPEAT_MODE_CHANGED": unknown;
	"chromeCast/REQUEST_START_CASTING": void;
	"chromeCast/SESSION_STATE_CHANGED": {
		currentTime: number;
		sessionState: unknown;
	};
	"chromeCast/UPSTREAM_QUEUE_CHANGED": string;
	// #endregion

	// #region cloudQueue
	"cloudQueue/ADD_ITEMS_TO_CLOUD_QUEUE": {
		context: PlayQueueContext;
		itemId?: string;
		mediaItemIds: ItemId[];
		mode: CloudQueueAddItemMode;
		priority: PlayQueuePriority;
	};
	"cloudQueue/ADD_ITEMS_TO_CLOUD_QUEUE_FAIL": {
		error: string;
	};
	"cloudQueue/ADD_ITEMS_TO_CLOUD_QUEUE_SUCCESS": {
		etag: string;
		headPosition?: number;
		tailItemId?: string;
		tailPosition?: number;
	};
	"cloudQueue/CREATE_CLOUD_QUEUE": {
		autoplay: boolean;
		currentTime: number;
		parameters?: {
			context: PlayQueueContext;
			forceShuffle: boolean;
			mediaItemIds: ItemId[];
			position?: number | null;
			priority: PlayQueuePriority;
		};
	};
	"cloudQueue/CREATE_CLOUD_QUEUE_FAIL": {
		error: string;
	};
	"cloudQueue/CREATE_CLOUD_QUEUE_SUCCESS": CloudQueue;
	"cloudQueue/FILL_CLOUD_QUEUE_WITH_HISTORY": {
		context: PlayQueueContext;
		totalNumberOfItems: number;
	};
	"cloudQueue/GET_CLOUD_QUEUE_ITEMS": void;
	"cloudQueue/GET_CLOUD_QUEUE_ITEMS_FAIL": void;
	"cloudQueue/GET_CLOUD_QUEUE_ITEMS_SUCCESS": {
		items: CloudQueueItem[];
	};
	"cloudQueue/GET_CLOUD_QUEUE_SUCCESS": {
		etag: string;
		position: number;
		shuffled: boolean;
	};
	"cloudQueue/MOVE_TRACKS": {
		afterId: string;
		ids: ItemId[];
	};
	"cloudQueue/MOVE_TRACKS_SUCCESS": {
		etag: string;
	};
	"cloudQueue/REMOVE_ELEMENT": {
		etag: string;
	};
	"cloudQueue/REMOVE_ELEMENT_SUCCESS": {
		etag: string;
	};
	"cloudQueue/SET_CURRENT_ITEM": {
		itemId: string;
	};
	"cloudQueue/SET_SHUFFLED": {
		shouldShuffle?: boolean;
	};
	"cloudQueue/SET_SHUFFLED_FAIL": void;
	"cloudQueue/SET_SHUFFLED_SUCCESS": {
		shuffled?: boolean;
	};
	"cloudQueue/UPDATE_ITEMS_ETAG": {
		etag: string;
	};
	// #endregion

	// #region content
	"content/ADD_ALBUMS": {
		albums: Album[];
	};
	"content/ADD_ALBUM_TO_PLAYLIST": {
		albumId: ItemId;
		playlistUUID: ItemId;
	};
	"content/ADD_ITEMS_TO_FAVORITES_SUCCESS": unknown;
	"content/ADD_MEDIA_ITEMS_TO_PLAYLIST": {
		addToIndex?: number;
		mediaItemIdsToAdd: ItemId[];
		onArtifactNotFound?: "ADD" | "FAIL" | "SKIP";
		onDupes: "ADD" | "FAIL" | "SKIP";
		playlistUUID: ItemId;
		showNotification?: boolean;
	};
	"content/ADD_MEDIA_ITEMS_TO_PLAYLIST_FAIL": void;
	"content/ADD_MEDIA_ITEMS_TO_PLAYLIST_SUCCESS": {
		addToIndex?: number;
		dateAdded?: string | null;
		mediaItemIdsToAdd: ItemId[];
		playlistUUID: ItemId;
	};
	"content/ADD_MEDIA_ITEM_IDS_TO_FAVORITES": {
		forceFavorite?: boolean;
		from: "contextMenu" | "dragDrop" | "heart";
		mediaItemIds: ItemId[];
		moduleId?: string | null;
		name?: string;
	};
	"content/ADD_PLAYLISTS": {
		playlists: Playlist[];
	};
	"content/ADD_PLAYLIST_TO_INDEX": {
		addToIndex: number;
		fromPlaylistUuid: ItemId;
		onArtifactNotFound?: "FAIL" | "SKIP";
		onDupes: "ADD" | "FAIL" | "SKIP";
		playlistUUID: ItemId;
		showNotification?: boolean;
	};
	"content/ADD_PLAYLIST_TO_INDEX_SUCCESS": {
		fromPlaylistUuid: ItemId;
		playlistUUID: ItemId;
	};
	"content/ADD_SUGGESTED_ITEM_TO_PLAYLIST": {
		addToIndex?: number;
		dateAdded?: string;
		mediaItemIdsToAdd: ItemId[];
		playlistUUID: ItemId;
	};
	"content/ADD_SUGGESTED_ITEM_TO_PLAYLIST_FAIL": {
		mediaItemIdsToRestore: ItemId[];
		playlistUUID: ItemId;
	};
	"content/CANCEL_PENDING_SUGGESTION": {
		mediaItemId: ItemId;
		playlistUUID: ItemId;
	};
	"content/CLEAR_PLAYLIST_LISTS_FILTER_DATA": void;
	"content/CREATE_TRACK_LIST": {
		dataApiPath?: string;
		entityId?: ItemId;
		entityType?: TrackListEntityType;
		trackListName: string;
	};
	"content/DELETE_PLAYLIST": {
		playlistUUID: ItemId;
	};
	"content/DELETE_PLAYLIST_FAIL": {
		playlistUUID: ItemId;
	};
	"content/DELETE_PLAYLIST_SUCCESS": {
		playlistUUID: ItemId;
		sourceFolderUuid?: ItemId;
	};
	"content/DELETE_TRACK_LIST": {
		key: string;
	};
	"content/FETCH_AND_PLAY_MEDIA_ITEM": {
		fromRemote?: boolean;
		itemId: ItemId;
		itemType: ContentType;
		sourceContext: MediaCollectionContext;
	};
	"content/HYDRATE_SORT_ORDERS": {
		sortOrders: StoredSortOrders;
	};
	"content/LAZY_LOAD_MEDIA_ITEMS_SUCCESS": {
		items: Record<ItemId, MediaItem>;
	};
	"content/LOAD_ALBUM": {
		albumId: ItemId;
	};
	"content/LOAD_ALBUM_SUCCESS": {
		albumId: ItemId;
	};
	"content/LOAD_ALL_ALBUM_MEDIA_ITEMS": {
		albumId: ItemId;
	};
	"content/LOAD_ALL_ALBUM_MEDIA_ITEMS_FAIL": {
		albumId: ItemId;
	};
	"content/LOAD_ALL_ALBUM_MEDIA_ITEMS_SUCCESS": {
		albumId: ItemId;
		mediaItems: MediaItem[];
	};
	"content/LOAD_ALL_ALBUM_MEDIA_ITEMS_WITH_CREDITS": {
		albumId: ItemId;
	};
	"content/LOAD_ALL_ALBUM_MEDIA_ITEMS_WITH_CREDITS_FAIL": {
		albumId: ItemId;
	};
	"content/LOAD_ALL_ALBUM_MEDIA_ITEMS_WITH_CREDITS_SUCCESS": {
		albumId: ItemId;
		credits: Record<string, Credit[]>;
		mediaItems: MediaItem[];
	};
	"content/LOAD_ALL_FAVORITES": void;
	"content/LOAD_ARTIST": {
		artistId: ItemId;
	};
	"content/LOAD_ARTIST_FAIL": {
		artistId: ItemId;
	};
	"content/LOAD_ARTIST_SUCCESS": {
		artist: Artist;
		bio?: ArtistBio | null;
		id: ItemId;
		mixId?: string;
	};
	"content/LOAD_CREATED_PLAYLISTS": {
		getAll?: boolean;
		limit?: number;
		reset?: boolean;
	};
	"content/LOAD_CREATED_PLAYLISTS_SUCCESS": {
		newOffset: number;
		playlists: Playlist[];
		reset?: boolean;
		totalNumberOfItems: number;
	};
	"content/LOAD_DYNAMIC_CONTRIBUTOR_PAGE": {
		artistId: ItemId;
	};
	"content/LOAD_DYNAMIC_MIX_PAGE": {
		mixId: ItemId;
	};
	"content/LOAD_DYNAMIC_PAGE": {
		name: string;
		path?: string;
	};
	"content/LOAD_DYNAMIC_PAGE_FAIL": {
		error: string;
		errorPlaceholder?: "mix";
		name: string;
	};
	"content/LOAD_DYNAMIC_PAGE_MODIFIED": unknown;
	"content/LOAD_DYNAMIC_PAGE_NOT_MODIFIED": unknown;
	"content/LOAD_DYNAMIC_PAGE_SUCCESS": {
		eTag?: string | null;
		name: string;
		normalizedDynamicPage: unknown;
	};
	"content/LOAD_FAVORITE_ALBUMS": unknown;
	"content/LOAD_FAVORITE_ARTISTS": unknown;
	"content/LOAD_FAVORITE_MIXES": unknown;
	"content/LOAD_FAVORITE_TRACKS": LoadFavoriteMediaItem;
	"content/LOAD_FAVORITE_VIDEOS": LoadFavoriteMediaItem;
	"content/LOAD_ITEM_CONTRIBUTORS": {
		itemId: ItemId;
		itemType: ItemType;
	};
	"content/LOAD_ITEM_CONTRIBUTORS_FAIL": {
		error: any;
		itemId: ItemId;
		itemType: ItemType;
	};
	"content/LOAD_ITEM_CONTRIBUTORS_SUCCESS": {
		credits: Credit[];
		itemId: ItemId;
		itemType: ItemType;
	};
	"content/LOAD_ITEM_LYRICS": {
		itemId: ItemId;
		itemType: ItemType;
	};
	"content/LOAD_ITEM_LYRICS_FAIL": {
		itemId: ItemId;
	};
	"content/LOAD_ITEM_LYRICS_SUCCESS": Lyrics;
	"content/LOAD_LIST_ITEMS_PAGE": {
		failSilently?: boolean | null;
		limit?: number;
		listName: string;
		listType: ItemsPageListType;
		loadAll?: boolean;
		order?: SortOrder | null;
		orderDirection?: SortDirection | null;
		query?: string;
		reset?: boolean | null;
		useCursor?: boolean | null;
	};
	"content/LOAD_LIST_ITEMS_PAGE_FAIL": {
		error: string;
		listName: string;
		listType: ItemsPageListType;
		order?: SortOrder | null;
		orderDirection?: SortDirection | null;
	};
	"content/LOAD_LIST_ITEMS_PAGE_SUCCESS": List;
	"content/LOAD_LIST_ITEMS_PAGE_SUCCESS_MODIFIED": unknown;
	"content/LOAD_LIST_ITEMS_PAGE_SUCCESS_NOT_MODIFIED": unknown;
	"content/LOAD_MULTIPLE_ARTISTS_SUCCESS": unknown;
	"content/LOAD_PLAYLIST": {
		playlistUUID: ItemId;
	};
	"content/LOAD_PLAYLIST_FAIL": {
		playlistUUID: ItemId;
	};
	"content/LOAD_PLAYLIST_SUCCESS": {
		playlist: Playlist;
	};
	"content/LOAD_PLAYLIST_SUGGESTED_MEDIA_ITEMS": {
		playlistUUID: ItemId;
		reset?: boolean | null;
	};
	"content/LOAD_PLAYLIST_SUGGESTED_MEDIA_ITEMS_FAIL": {
		playlistUUID: ItemId;
	};
	"content/LOAD_PLAYLIST_SUGGESTED_MEDIA_ITEMS_SUCCESS": {
		mediaItems: MediaItem[];
		playlistUUID: ItemId;
		totalNumberOfItems: number;
	};
	"content/LOAD_RECENT_ACTIVITY": unknown;
	"content/LOAD_RECENT_ACTIVITY_FAIL": unknown;
	"content/LOAD_RECENT_ACTIVITY_SUCCESS": unknown;
	"content/LOAD_SINGLE_MEDIA_ITEM": unknown;
	"content/LOAD_SINGLE_MEDIA_ITEM_FAIL": unknown;
	"content/LOAD_SINGLE_MEDIA_ITEM_SUCCESS": {
		mediaItem: MediaItem;
	};
	"content/LOAD_SUGGESTIONS": {
		failSilently?: boolean | null;
		itemId: ItemId;
		itemType: string;
	};
	"content/LOAD_SUGGESTIONS_FAIL": void;
	"content/LOAD_SUGGESTIONS_SUCCESS": {
		mediaItems: MediaItem[];
		totalNumberOfItems: number;
	};
	"content/MEDIA_ITEM_ID_REPLACED": {
		originalTrackId: ItemId;
		replacedTrackId: ItemId;
	};
	"content/MOVE_PLAYLIST_MEDIA_ITEMS": {
		indices: number[];
		moveToIndex: number;
		playlistUUID: ItemId;
	};
	"content/MOVE_PLAYLIST_MEDIA_ITEMS_FAIL": unknown;
	"content/MOVE_PLAYLIST_MEDIA_ITEMS_SUCCESS": {
		indices: number[];
		moveToIndex: number;
		playlistUUID: ItemId;
	};
	"content/RECEIVED_FULL_TRACK_LIST_MEDIA_ITEMS": {
		eTag?: string | null;
		items: MediaItem[];
		order?: SortOrder | null;
		orderDirection?: SortDirection | null;
		totalNumberOfItems: number;
		trackList: string;
	};
	"content/REMOVE_ITEMS_FROM_FAVORITES_SUCCESS": unknown;
	"content/REMOVE_MEDIA_ITEMS_FROM_PLAYLIST": {
		currentDirection: SortDirection;
		currentOrder: SortOrder;
		mediaItemId?: ItemId;
		moduleId?: string | null;
		playlistUUID: ItemId;
		removeIndices: number[];
	};
	"content/REMOVE_MEDIA_ITEMS_FROM_PLAYLIST_SUCCESS": {
		currentDirection: SortDirection;
		currentOrder: SortOrder;
		playlistUUID: ItemId;
		removeIndices: number[];
	};
	"content/SET_FOLDER_STATE_KEY": {
		context: "all" | "folder" | "page" | "sidebar";
		contextId: ItemId;
	};
	"content/SHOW_CREATE_PLAYLIST_FROM_ALBUM_DIALOG": {
		albumId: ItemId;
		moduleId?: string;
	};
	"content/TOGGLE_FAVORITE_ITEMS": {
		forceFavorite?: boolean;
		from: "contextMenu" | "dragDrop" | "heart";
		items: unknown[];
		moduleId?: string | null;
		name?: string;
	};
	"content/TOGGLE_TRACK_LIST_SORTING": {
		defaultDirection?: SortDirection;
		order: SortOrder;
		trackListName: string;
	};
	"content/UPDATE_ARTIST": unknown;
	"content/UPDATE_PLAYLIST": {
		playlistMeta: PlaylistMeta;
		playlistUUID: ItemId;
	};
	"content/UPDATE_PLAYLIST_FAIL": {
		playlistUUID: ItemId;
	};
	"content/UPDATE_PLAYLIST_SUCCESS": {
		playlistMeta: PlaylistMeta;
		playlistUUID: ItemId;
	};
	// #endregion

	// #region contextMenu
	"contextMenu/CLOSE": void;
	"contextMenu/OPEN": ContextMenu;
	"contextMenu/OPEN_BLOCK_ITEM": BlockItemContextMenu;
	"contextMenu/OPEN_CREATOR_CONTENT_OWNED_ITEM": unknown;
	"contextMenu/OPEN_CREATOR_CONTENT_RECEIVED_ITEM": unknown;
	"contextMenu/OPEN_EMPTY_FOLDER": EmptyFolderContextMenu;
	"contextMenu/OPEN_INPUT_FIELD_CLIPBOARD": InputFieldClipboardContextMenu;
	"contextMenu/OPEN_MEDIA_ITEM": MediaItemContextMenu;
	"contextMenu/OPEN_MULTI_MEDIA_ITEM": MultiMediaItemContextMenu;
	"contextMenu/UPDATE_POSITION": {
		time: number;
	};
	// #endregion

	// #region creatorContent
	"creatorContent/FINISH_ARTWORK_UPLOAD": unknown;
	"creatorContent/FINISH_TRACK_UPLOAD": unknown;
	"creatorContent/SET_TRACK_ITEM_ID": unknown;
	"creatorContent/SET_TRACK_UPLOAD_ERROR": unknown;
	"creatorContent/SET_TRACK_UPLOAD_PROGRESS": unknown;
	"creatorContent/START_ARTWORK_UPLOAD": unknown;
	"creatorContent/START_TRACK_UPLOAD": unknown;
	// #endregion

	// #region dialog
	"dialog/CLOSE_DIALOG": unknown;
	"dialog/OPEN_DIALOG": unknown;
	// #endregion

	// #region etag
	"etag/SET_PLAYLIST_ETAG": {
		etag: string;
		playlistId: ItemId;
	};
	// #endregion

	// #region eventTracking
	"eventTracking/ADD_REMOVE_FAVORITES": unknown;
	"eventTracking/CHANGE_STREAM_QUALITY": unknown;
	"eventTracking/CLICK_MODULE": unknown;
	"eventTracking/CLICK_SUGGESTED_TRACKS_PLAYNOW": {
		contentId: ItemId;
		contentPlacement: number;
		contentType: ContentType;
	};
	"eventTracking/CONTROL_CLICKS_PLAYNOW": {
		buttonId: string;
	};
	"eventTracking/CREATE_NEW_PLAYLIST": unknown;
	"eventTracking/DISPLAY_PAGE": unknown;
	"eventTracking/EXPAND_CREDITS": unknown;
	"eventTracking/MOVE_FOLDER_ITEMS": unknown;
	"eventTracking/REMOVE_FOLDER_ITEMS": unknown;
	"eventTracking/SCROLL_PAGE": unknown;
	// #endregion

	// #region experimentationPlatform
	"experimentationPlatform/ACTIVATE_EXPERIMENT": string;
	"experimentationPlatform/ACTIVATE_EXPERIMENT_SUCCESS": unknown;
	"experimentationPlatform/GET_EXPERIMENTS": void;
	"experimentationPlatform/GET_EXPERIMENTS_SUCCESS": {
		authType: "ANONYMOUS" | "AUTHENTICATED";
		response: unknown;
	};
	"experimentationPlatform/HYDRATE_ACTIVATE_EXPERIMENTS": ExperimentationPlatform;
	// #endregion

	// #region favorites
	"favorites/SET_FAVORITE_IDS": Favorites;
	// #endregion

	// #region featureFlags
	"featureFlags/GET_FLAGS": {
		flags: FeatureFlag[];
		userAttributes?: Record<string, boolean | number | string>;
	};
	"featureFlags/READY": unknown;
	"featureFlags/RESET_CACHE": unknown;
	"featureFlags/SET_FLAGS": FeatureFlags["flags"];
	"featureFlags/SET_USER_OVERRIDES": unknown;
	"featureFlags/TOGGLE_USER_OVERRIDE": FeatureFlag;
	// #endregion

	// #region feed
	"feed/CHECK_FEED_UPDATES": void;
	"feed/CHECK_FEED_UPDATES_SUCCESS": {
		hasNewFeedItems: boolean;
	};
	"feed/HAS_SEEN_FEED": void;
	"feed/LOAD_FEED": void;
	"feed/LOAD_FEED_FAIL": void;
	"feed/LOAD_FEED_SUCCESS": unknown;
	// #endregion

	// #region folders
	"folders/ADD_FAVORITES_TO_FOLDER": {
		eventAction: EventAction;
		eventModuleId?: ItemId;
		folderId?: ItemId;
		uuids: ItemId[];
	};
	"folders/CREATE_AI_PLAYLIST": CreatePlaylistPayload;
	"folders/CREATE_FOLDER": {
		eventAction: EventAction;
		eventContentId?: ItemId;
		eventContentType?: string;
		eventModuleId?: ItemId | null;
		folderId?: string;
		itemType?: string;
		name: string;
		trns?: string[];
	};
	"folders/CREATE_PLAYLIST": CreatePlaylistPayload;
	"folders/LOAD_FOLDER_ITEMS": LoadFolderItemsPayload;
	"folders/LOAD_FOLDER_ITEMS_FAIL": unknown;
	"folders/LOAD_FOLDER_ITEMS_SUCCESS": LoadFolderItemsSuccess;
	"folders/LOAD_SPECIFIC_FOLDER_ITEMS_SUCCESS": LoadSpecificFolderItemsSuccess;
	"folders/MOVE_ITEMS_TO_FOLDER": {
		eventAction: EventAction;
		eventModuleId?: ItemId;
		folderId: ItemId;
		folderItemIds: ItemId[];
		sourceFolderUuid?: ItemId;
	};
	"folders/RELOAD_PLAYLIST_WITH_RETRY": {
		playlistUUID: ItemId;
	};
	"folders/REMOVE_FOLDER_ITEM": {
		eventModuleId?: ItemId;
		itemType: string;
		removeFavorite?: boolean;
		trns: ItemId[];
	};
	"folders/RENAME_FOLDER": {
		name: string;
		trn: string;
	};
	"folders/TOGGLE_FAVORITES_IN_FOLDER": {
		eventModuleId?: ItemId;
		folderId?: string;
		itemIds: ItemId[];
		itemType: string;
	};
	// #endregion

	// #region homepage
	"homepage/CONTEXT_MENU_OPENED": unknown;
	"homepage/HYDRATE_TRACKED_ITEMS": unknown;
	"homepage/LOAD_AND_ENQUEUE_ALL_VIEW_ALL_TRACKS": unknown;
	"homepage/PLAY_SINGLE_TRACK": unknown;
	"homepage/STORE_HYDRATED_TRACKED_ITEMS": unknown;
	"homepage/STORE_TRACKED_ITEM": unknown;
	"homepage/TRACK_HOME_PAGE_VIEW": unknown;
	"homepage/TRACK_ITEM": unknown;
	"homepage/TRACK_SAVE_ITEM": unknown;
	// #endregion

	// #region lastFm
	"lastFm/DISCONNECT": void;
	"lastFm/LOGIN": void;
	"lastFm/REFRESH_SESSION": void;
	"lastFm/SET_CONNECTION_STATE": boolean;
	// #endregion

	// #region launchHandler
	"launchHandler/LAUNCH": {
		files: string[];
		targetURL: string;
	};
	// #endregion

	// #region lists
	/** @example "locale" */
	"locale/BUNDLE_SWITCH_SUCCESS": string;
	"locale/LOAD_BUNDLE_SUCCESS": {
		bundle: LocaleBundle;
		/** @example "en-us" */
		language: string;
	};
	// #region

	// #region message
	"message/CLEAR_MESSAGE": {
		id: number;
	};
	"message/CLEAR_MESSAGES": void;
	"message/MEDIA_NOT_PLAYABLE": {
		id: ItemId;
		isVideo: boolean;
	};
	"message/MESSAGE_BLOCK": Message;
	"message/MESSAGE_DESKTOP_RELEASE": Message;
	"message/MESSAGE_ERROR": Message;
	"message/MESSAGE_INFO": Message;
	"message/MESSAGE_RELEASE": Message;
	"message/MESSAGE_WARN": Message;
	// #endregion

	// #region mix
	"mix/ADD_MIX_TO_PLAYLIST": {
		mixId: ItemId;
		playlistUUID: ItemId;
	};
	"mix/LOAD_ALL_MIX_MEDIA_ITEMS_SUCCESS": {
		mediaItems: MediaItem[];
		mixId: ItemId;
		reset?: boolean;
	};
	"mix/LOAD_MIXES_SUCCESS": unknown;
	"mix/LOAD_TRACK_LIST_FOR_MIX_ID": {
		failSilently?: boolean | null;
		mixId: ItemId;
		reset?: boolean;
	};
	"mix/LOAD_TRACK_MIX_ID": {
		id: ItemId;
	};
	"mix/LOAD_TRACK_MIX_ID_FAIL": {
		error: string;
		trackId: ItemId;
	};
	"mix/LOAD_TRACK_MIX_ID_SUCCESS": {
		mixId: ItemId;
		trackId: ItemId;
	};
	"mix/PLAY_MIX": {
		forceShuffle: boolean;
		fromIndex: number;
		mixId: ItemId;
	};
	"mix/SHOW_CREATE_PLAYLIST_FROM_MIX_DIALOG": {
		mixId: ItemId;
		moduleId?: string | null;
	};
	// #endregion

	// #region modal
	"modal/ADD_MULTIPLE_ITEMS_TO_FOLDER_MODAL": {
		contentType: "CONTENT_TYPE_FOLDER";
		folderId: ItemId;
	};
	"modal/ADD_TO_FOLDER_MODAL": {
		contentType: "CONTENT_TYPE_PLAYLIST";
		fromPlaylistUuid: ItemId;
	};
	"modal/ADD_TO_PLAYLIST_MODAL": AddToPlaylistModal;
	"modal/CAN_CLOSE": unknown;
	"modal/CLOSE": void;
	"modal/REMOTE_PLAYBACK_RECEIVER_DISCONNECT_MODAL": unknown;
	"modal/SELECT_PLAYLIST_FROM_MODAL": {
		playlistUUID: ItemId;
	};
	"modal/SHOW_ARTISTS_MODAL": {
		artists: ArtistInline[];
	};
	"modal/SHOW_ARTIST_BIO": {
		artistId: ItemId;
	};
	"modal/SHOW_CONFIRM": ConfirmModal;
	"modal/SHOW_CONFIRM_EXIT_MODAL": void;
	"modal/SHOW_CREATE_AI_PLAYLIST": CreateAiPlaylistModal;
	"modal/SHOW_CREATE_PLAYLIST": CreatePlaylistModal;
	"modal/SHOW_DELETE_ARTIST_PICTURE": unknown;
	"modal/SHOW_DELETE_PROFILE_PICTURE": void;
	"modal/SHOW_DESKTOP_RELEASE_NOTES": void;
	"modal/SHOW_DOLBY_ATMOS": void;
	"modal/SHOW_EDIT_PLAYLIST_META": {
		mode: "edit";
		playlistUUID: ItemId;
	};
	"modal/SHOW_EXPLICIT_TOGGLE_MODAL": void;
	"modal/SHOW_INTRO_UPGRADE_MODAL": void;
	"modal/SHOW_LOGOUT_MODAL": void;
	"modal/SHOW_ONBOARDING_MODAL": {
		step: OnboardingStep;
	};
	"modal/SHOW_PICK_ALBUM_MODAL": PickItemModal;
	"modal/SHOW_PICK_ARTIST_MODAL": PickItemModal;
	"modal/SHOW_PICK_TRACK_MODAL": PickItemModal;
	"modal/SHOW_PLAYLIST_INFO_MODAL": {
		uuid: ItemId;
	};
	"modal/SHOW_RELEASE_NOTES": void;
	"modal/SHOW_SHORTCUTS": void;
	"modal/SHOW_UNSUPPORTED_OS_MODAL": void;
	"modal/SHOW_USER_PROFILES_ONBOARDING_MODAL": {
		mode: "onboarding" | "selectPublicPlaylists";
	};
	// #endregion

	// #region network
	"network/CONNECT": {
		interval: number;
		timeout: number;
	};
	"network/CONNECTION_ESTABLISHED": void;
	"network/CONNECTION_LOST": void;
	"network/CONNECTION_REFRESH": void;
	"network/FAILED_STARTUP": void;
	// #endregion

	// #region noop
	noop: unknown;
	// #endregion

	// #region page
	"page/SET_PAGE_ID": string;
	// #endregion

	// #region playQueue
	"playQueue/ADD_ALREADY_LOADED_ITEMS_TO_QUEUE": {
		clearActives?: boolean;
		context: PlayQueueContext;
		forceShuffle?: boolean;
		fromIndex?: number;
		items: ItemId[];
		position: PlayQueuePosition;
	};
	"playQueue/ADD_AT_INDEX": {
		context: PlayQueueContext;
		mediaItemIds: ItemId[];
		index: number;
	};
	"playQueue/ADD_LAST": {
		context: PlayQueueContext;
		mediaItemIds: ItemId[];
		shuffleSeed?: number;
	};
	"playQueue/ADD_MEDIA_ITEMS_TO_QUEUE": {
		mediaItemIds: ItemId[];
		options?: {
			fromRemote?: boolean;
			overwritePlayQueue?: boolean;
			source?: string;
		};
		position: PlayQueuePosition;
		sourceContext: MediaCollectionContext;
	};
	"playQueue/ADD_NEXT": {
		context: PlayQueueContext;
		mediaItemIds: ItemId[];
		offset?: number;
	};
	"playQueue/ADD_NOW": {
		context: PlayQueueContext;
		mediaItemIds: ItemId[];
		fromIndex?: number;
		overwritePlayQueue?: boolean;
		shuffleSeed?: number | null;
	};
	"playQueue/ADD_NOW_REST_OF_TRACK_LIST": {
		context: PlayQueueContext;
		mediaItemIds: ItemId[];
		shuffleSeed?: number;
	};
	"playQueue/ADD_PROMO_ITEM_TO_QUEUE": {
		mediaItemId: string;
		mediaItemType: ContentType;
	};
	"playQueue/ADD_STREAMABLE_ITEMS_TO_QUEUE_FAIL": void;
	"playQueue/ADD_STREAMABLE_ITEMS_TO_QUEUE_SUCCESS": unknown;
	"playQueue/ADD_TRACK_LIST_TO_PLAY_QUEUE": {
		clearActives?: boolean;
		context: PlayQueueContext;
		dataApiPath?: string;
		disableShuffle?: boolean;
		entityId?: ItemId;
		entityItemsType?: ContentType;
		entityType?: string;
		forceShuffle?: boolean;
		fromIndex?: number;
		order?: SortOrder | null;
		orderDirection?: SortDirection | null;
		position: PlayQueuePosition;
		sourceTitle?: string;
		trackListName: string;
	};
	"playQueue/CLEAR_ACTIVE_ITEMS": void;
	"playQueue/CLEAR_QUEUE": void;
	"playQueue/CLONE_TRACK": {
		fromIndex: number;
		toIndex: number;
	};
	"playQueue/DISABLE_SHUFFLE_MODE": void;
	"playQueue/DISABLE_SHUFFLE_MODE_AND_UNSHUFFLE_ITEMS": void;
	"playQueue/ENABLE_SHUFFLE_MODE": void;
	"playQueue/ENABLE_SHUFFLE_MODE_AND_SHUFFLE_ITEMS": {
		shuffleSeed: number;
	};
	"playQueue/FETCH_FIRST_PAGE_AND_ADD_TO_QUEUE": {
		clearActives?: boolean;
		context: PlayQueueContext;
		currentDirection?: SortDirection | null | undefined;
		currentOrder?: SortOrder | null | undefined;
		forceShuffle?: boolean;
		fromIndex?: number;
		playQueueLimit?: number | null;
		position: PlayQueuePosition;
		trackListName: string;
	};
	"playQueue/FETCH_REST_OF_THE_TRACKS_AND_ADD_TO_QUEUE": {
		clearActives?: boolean;
		context: PlayQueueContext;
		currentDirection: SortDirection | null | undefined;
		currentOrder: SortOrder | null | undefined;
		forceShuffle?: boolean;
		fromIndex?: number;
		numberOfItemsAddedBeforeLoading: number;
		playQueueLimit: number;
		position: PlayQueuePosition;
		totalNumberOfItems: number;
		trackListName: string;
	};
	"playQueue/FILTER_QUEUE_ON_ADD_ITEM_TO_BLOCK": {
		itemToBlock: {
			context: MediaCollectionContext;
			id: ItemId;
			itemType: ItemType;
		};
		mediaItems: Record<string, MediaItem>;
		shouldSkip: boolean;
	};
	"playQueue/LOAD_PLAYER_SETTINGS_FROM_LOCAL_STORAGE_SUCCESS": {
		repeat: RepeatMode;
		shuffle: boolean;
	};
	"playQueue/LOAD_PLAY_QUEUE_FROM_LOCAL_STORAGE_SUCCESS": {
		currentIndex: number;
		lastShuffleSeed?: number;
		mediaItems: Record<string, MediaItem>;
		sourceName?: string;
		sourceTrackListName?: string;
		sourceUrl?: string;
		uniqueIdCounter: number;
		userId: number;
	};
	"playQueue/MOVE_NEXT": void;
	"playQueue/MOVE_PREVIOUS": void;
	"playQueue/MOVE_TO": number;
	"playQueue/MOVE_TRACK": {
		fromIndex: number;
		toIndex: number;
	};
	"playQueue/PLAY_SOUNDTRACK_PROMPT_TRACK": unknown;
	"playQueue/REMOVE_AT_INDEX": {
		index: number;
	};
	"playQueue/REMOVE_ELEMENT": {
		uid: string;
	};
	"playQueue/RESET": {
		currentIndex?: number;
		elements: PlayQueueElement[];
		originalSource?: PlayQueueElement[];
		uniqueIdCounter?: number;
	};
	"playQueue/SET_CURRENT_INDEX": number;
	"playQueue/SET_REPEAT_MODE": RepeatMode;
	"playQueue/SET_SOURCE_PROPERTIES": {
		dataApiPath?: string;
		entityId?: number | string;
		entityItemsType?: ContentType;
		entityType?: string;
		limit?: number;
		name: string;
		trackListName: string;
		url?: string;
	};
	"playQueue/TOGGLE_REPEAT_MODE": void;
	"playQueue/TOGGLE_SHUFFLE": void;
	"playQueue/UPDATE_ORIGINAL_SOURCE": {
		context: PlayQueueContext;
		mediaItemIds: ItemId[];
	};
	// #endregion

	// #region playbackControls
	"playbackControls/DECREASE_VOLUME": void;
	"playbackControls/ENDED": { reason: "completed" | "skip" };
	"playbackControls/INCREASE_VOLUME": void;
	"playbackControls/MEDIA_PRODUCT_TRANSITION": {
		mediaProduct: MediaProduct;
		playbackContext: PlaybackContext;
	};
	"playbackControls/PAUSE": void;
	"playbackControls/PLAY": void;
	"playbackControls/PREFILL_MEDIA_PRODUCT_TRANSITION": {
		mediaProduct: MediaProduct;
		playbackContext: {
			actualDuration: number;
		};
	};
	"playbackControls/SEEK": number;
	"playbackControls/SEEK_BACKWARDS": number | undefined;
	"playbackControls/SEEK_FORWARDS": number | undefined;
	"playbackControls/SET_DESIRED_PAUSE_STATE": void;
	"playbackControls/SET_DURATION": number;
	"playbackControls/SET_MUTE": boolean;
	"playbackControls/SET_PLAYBACK_STATE": PlaybackState;
	"playbackControls/SET_VOLUME": {
		volume: number;
	};
	"playbackControls/SET_VOLUME_UNMUTE": unknown;
	"playbackControls/SKIP_NEXT": void;
	"playbackControls/SKIP_PREVIOUS": void;
	"playbackControls/START_AT": number;
	"playbackControls/STOP": void;
	"playbackControls/TIME_UPDATE": number;
	"playbackControls/TOGGLE_MUTE": void;
	"playbackControls/TOGGLE_PLAYBACK": void;
	"playbackControls/UPDATE_PLAYBACK_CONTEXT": unknown;
	// #endregion

	// #region playbackControlsActions
	"playbackControlsActions/INDICATE_MUTE": {
		mute: boolean;
	};
	"playbackControlsActions/INDICATE_VOLUME": {
		volume: number;
	};
	// #endregion

	// #region player
	"player/CANCEL_TOUCH_AND_GO": unknown;
	"player/ENSURE_PLAYBACK_PRIVILEGES": unknown;
	"player/ERROR": unknown;
	"player/FORCE_AUTOMATIC_PROGRESSION": unknown;
	"player/PRELOAD_ITEM": MediaProduct;
	"player/PRELOAD_NEXT_ITEM": MediaProduct;
	"player/PRELOAD_SUCCESS": undefined;
	"player/SET_ACTIVE_DEVICE": unknown;
	"player/SET_ACTIVE_DEVICE_SUCCESS": unknown;
	"player/SET_AVAILABLE_DEVICES": unknown;
	"player/SET_DEVICE_MODE": unknown;
	"player/SET_DEVICE_MODE_SUCCESS": unknown;
	"player/SET_FORCE_VOLUME": unknown;
	"player/STREAMING_PRIVILEGES_REVOKED": unknown;
	// #endregion

	// #region remotePlayback
	"remotePlayback/CONNECTION_LOST": void;
	"remotePlayback/CONNECT_TO_DEVICE": {
		device: RemotePlaybackDevice;
		deviceType: RemotePlaybackDeviceType;
	};
	"remotePlayback/CONNECT_TO_DEVICE_FAILED": void;
	"remotePlayback/DEVICES_RECEIVED": {
		deviceType: RemotePlaybackDeviceType;
		devices: RemotePlaybackDevice[];
	};
	"remotePlayback/DEVICE_CONNECTED": {
		device: RemotePlaybackDevice;
		resumed?: boolean;
		session?: unknown;
	};
	"remotePlayback/DEVICE_DISCONNECTED": {
		deviceType: RemotePlaybackDeviceType;
		error?: string;
		suspended?: boolean;
	};
	"remotePlayback/DISCONNECT_ALL_DEVICES": void;
	"remotePlayback/DISCOVER_DEVICES": void;
	"remotePlayback/REFRESH_DEVICES": void;
	"remotePlayback/chromeCast/DISCONNECT": void;
	"remotePlayback/chromeCast/UPDATE_PLAYER_STATE": unknown;
	"remotePlayback/chromeCast/UPSTREAM_QUEUE_CHANGED": string;
	"remotePlayback/cloudConnect/DISCONNECT": unknown;
	"remotePlayback/cloudConnect/UPSTREAM_QUEUE_CHANGED": unknown;
	"remotePlayback/remotePlaybackReceiver/DISCONNECT": unknown;
	"remotePlayback/remotePlaybackReceiver/MEDIA_CHANGED": unknown;
	"remotePlayback/remotePlaybackReceiver/STATE_CHANGED": unknown;
	"remotePlayback/tidalConnect/DISCONNECT": void;
	"remotePlayback/tidalConnect/HANDLE_ERROR": {
		details: {
			description:
				| {
						error: string;
						error_description: string;
						status: number;
						sub_status: number;
				  }
				| {
						error: string;
						status: number;
						subStatus: number;
						userMessage: string;
				  };
			subCode: number;
		};
		errorCode: number;
	};
	"remotePlayback/tidalConnect/MEDIA_CHANGED": TidalConnectMediaInfo;
	"remotePlayback/tidalConnect/QUEUE_CHANGED": TidalConnectMediaInfo;
	"remotePlayback/tidalConnect/QUEUE_ITEMS_CHANGED": TidalConnectQueueInfo;
	"remotePlayback/tidalConnect/UPDATE_PLAYER_STATE": {
		playerState: RemotePlaybackState;
		progress: number;
	};
	// #endregion

	// #region route
	"route/LOADER_DATA__ALBUM": unknown;
	"route/LOADER_DATA__ALBUM--FAIL": unknown;
	"route/LOADER_DATA__ALBUM--SUCCESS": unknown;
	"route/LOADER_DATA__ALBUM_CREDITS": unknown;
	"route/LOADER_DATA__ALBUM_CREDITS--FAIL": unknown;
	"route/LOADER_DATA__ALBUM_CREDITS--SUCCESS": unknown;
	"route/LOADER_DATA__ALBUM_TRACK_MIX": unknown;
	"route/LOADER_DATA__ALBUM_TRACK_MIX--FAIL": unknown;
	"route/LOADER_DATA__ALBUM_TRACK_MIX--SUCCESS": unknown;
	"route/LOADER_DATA__ARTIST": unknown;
	"route/LOADER_DATA__ARTIST--FAIL": unknown;
	"route/LOADER_DATA__ARTIST--SUCCESS": unknown;
	"route/LOADER_DATA__ARTIST_MIX": unknown;
	"route/LOADER_DATA__ARTIST_MIX--FAIL": unknown;
	"route/LOADER_DATA__ARTIST_MIX--SUCCESS": unknown;
	"route/LOADER_DATA__ARTIST_PICKER": unknown;
	"route/LOADER_DATA__ARTIST_PICKER--FAIL": unknown;
	"route/LOADER_DATA__ARTIST_PICKER--SUCCESS": unknown;
	"route/LOADER_DATA__BLOCKS": unknown;
	"route/LOADER_DATA__BLOCKS--FAIL": unknown;
	"route/LOADER_DATA__BLOCKS--SUCCESS": unknown;
	"route/LOADER_DATA__FACEBOOK": unknown;
	"route/LOADER_DATA__FACEBOOK--FAIL": unknown;
	"route/LOADER_DATA__FACEBOOK--SUCCESS": unknown;
	"route/LOADER_DATA__FOLDER": unknown;
	"route/LOADER_DATA__FOLDER--FAIL": unknown;
	"route/LOADER_DATA__FOLDER--SUCCESS": unknown;
	"route/LOADER_DATA__HOME": unknown;
	"route/LOADER_DATA__HOME--FAIL": unknown;
	"route/LOADER_DATA__HOME--SUCCESS": unknown;
	"route/LOADER_DATA__LASTFM": unknown;
	"route/LOADER_DATA__LASTFM--FAIL": unknown;
	"route/LOADER_DATA__LASTFM--SUCCESS": unknown;
	"route/LOADER_DATA__LOGIN": unknown;
	"route/LOADER_DATA__LOGIN--FAIL": unknown;
	"route/LOADER_DATA__LOGIN--SUCCESS": unknown;
	"route/LOADER_DATA__LOGIN_AUTH": unknown;
	"route/LOADER_DATA__MIX": unknown;
	"route/LOADER_DATA__MIX--FAIL": unknown;
	"route/LOADER_DATA__MIX--SUCCESS": unknown;
	"route/LOADER_DATA__MY_COLLECTION_ALBUMS": unknown;
	"route/LOADER_DATA__MY_COLLECTION_ALBUMS--FAIL": unknown;
	"route/LOADER_DATA__MY_COLLECTION_ALBUMS--SUCCESS": unknown;
	"route/LOADER_DATA__MY_COLLECTION_ARTISTS": unknown;
	"route/LOADER_DATA__MY_COLLECTION_ARTISTS--FAIL": unknown;
	"route/LOADER_DATA__MY_COLLECTION_ARTISTS--SUCCESS": unknown;
	"route/LOADER_DATA__MY_COLLECTION_MIXES": unknown;
	"route/LOADER_DATA__MY_COLLECTION_MIXES--FAIL": unknown;
	"route/LOADER_DATA__MY_COLLECTION_MIXES--SUCCESS": unknown;
	"route/LOADER_DATA__MY_COLLECTION_PLAYLISTS": unknown;
	"route/LOADER_DATA__MY_COLLECTION_PLAYLISTS--FAIL": unknown;
	"route/LOADER_DATA__MY_COLLECTION_PLAYLISTS--SUCCESS": unknown;
	"route/LOADER_DATA__MY_COLLECTION_TRACKS": unknown;
	"route/LOADER_DATA__MY_COLLECTION_TRACKS--FAIL": unknown;
	"route/LOADER_DATA__MY_COLLECTION_TRACKS--SUCCESS": unknown;
	"route/LOADER_DATA__MY_COLLECTION_VIDEOS": unknown;
	"route/LOADER_DATA__MY_COLLECTION_VIDEOS--FAIL": unknown;
	"route/LOADER_DATA__MY_COLLECTION_VIDEOS--SUCCESS": unknown;
	"route/LOADER_DATA__PLAYLIST": unknown;
	"route/LOADER_DATA__PLAYLIST--FAIL": unknown;
	"route/LOADER_DATA__PLAYLIST--SUCCESS": unknown;
	"route/LOADER_DATA__SEARCH": unknown;
	"route/LOADER_DATA__SEARCH--FAIL": unknown;
	"route/LOADER_DATA__SEARCH--SUCCESS": unknown;
	"route/LOADER_DATA__SETTINGS": unknown;
	"route/LOADER_DATA__SETTINGS--FAIL": unknown;
	"route/LOADER_DATA__SETTINGS--SUCCESS": unknown;
	"route/LOADER_DATA__SNAPCHAT": unknown;
	"route/LOADER_DATA__SNAPCHAT--FAIL": unknown;
	"route/LOADER_DATA__SNAPCHAT--SUCCESS": unknown;
	"route/LOADER_DATA__TIKTOK": unknown;
	"route/LOADER_DATA__TIKTOK--FAIL": unknown;
	"route/LOADER_DATA__TIKTOK--SUCCESS": unknown;
	"route/LOADER_DATA__TRACK": unknown;
	"route/LOADER_DATA__TRACK--FAIL": unknown;
	"route/LOADER_DATA__TRACK--SUCCESS": unknown;
	"route/LOADER_DATA__USER": unknown;
	"route/LOADER_DATA__USER--FAIL": unknown;
	"route/LOADER_DATA__USER--SUCCESS": unknown;
	"route/LOADER_DATA__VIDEO": unknown;
	"route/LOADER_DATA__VIDEO--FAIL": unknown;
	"route/LOADER_DATA__VIDEO--SUCCESS": unknown;
	"route/LOADER_DATA__VIEW": unknown;
	"route/LOADER_DATA__VIEW--FAIL": unknown;
	"route/LOADER_DATA__VIEW--SUCCESS": unknown;
	// #endregion

	// #region router
	"router/GO_BACK": unknown;
	"router/GO_FORWARD": unknown;
	"router/NAVIGATE": {
		to: {
			pathname: string;
			search: string;
			replace: true;
		};
	};
	"router/NAVIGATED": {
		params: unknown;
		path: string;
		search: string;
	};
	"router/OPEN_EXTERNAL_URL": {
		openInNewWindow: boolean;
		url: string;
	};
	"router/PUSH": {
		pathname: string;
		search: string;
		replace: boolean;
	};
	"router/REPLACE": void;
	// #endregion

	// #region search
	"search/ADD_TO_RECENT_SEARCHES": void;
	"search/CLEAR_LOADING": void;
	"search/CLEAR_RECENT_SEARCHES": void;
	"search/CLEAR_SEARCH_PHRASE": void;
	"search/QUERY_SUGGESTIONS_DISPLAYED": unknown;
	"search/QUERY_SUGGESTION_CLICKED": unknown;
	"search/RECENT_SEARCHES_RESTORED": RecentSearch[];
	"search/REFRESH_SEARCH_SESSION": unknown;
	"search/SEARCH_ALBUM_FOR_TRACK_PICKER": {
		limit?: number;
		searchPhrase: string;
	};
	"search/SEARCH_ARTIST_FOR_TRACK_PICKER": {
		limit?: number;
		searchPhrase: string;
	};
	"search/SEARCH_COMMIT": string;
	"search/SEARCH_FOR": unknown;
	"search/SEARCH_RESULTS_DISPLAYED": unknown;
	"search/SEARCH_RESULT_CONSUMED": unknown;
	"search/SEARCH_RESULT_FAIL": {
		error: string;
		query: string;
	};
	"search/SEARCH_RESULT_SUCCESS": SearchResultPayload;
	"search/SEARCH_TRACK_FOR_TRACK_PICKER": {
		limit?: number;
		searchPhrase: string;
	};
	"search/SET_SEARCH_PHRASE": {
		limit?: number;
		searchPhrase: string;
	};
	"search/SET_SEARCH_PHRASE_ON_LOGIN": unknown;
	"search/SET_SEARCH_RESULTS_FILTER_ORDER": unknown;
	"search/TRIGGER_NEW_SEARCH_SESSION": unknown;
	"search/UPDATE_SEARCH_SESSION": unknown;
	// #endregion

	// #region selection
	"selection/ADD_ITEMS": SelectionItem[];
	"selection/END_DRAG": void;
	"selection/REMOVE_ITEMS": SelectionItem[];
	"selection/RESET": void;
	"selection/SET_LOADED_SIDEBAR_FOLDERS": string[];
	"selection/SET_OPEN_SIDEBAR_FOLDERS": string[];
	"selection/START_DRAG": void;
	// #endregion

	// #region session
	"session/ACKNOWLEDGE_OUTDATED_OS": void;
	"session/AUTH_MODULE_INITIALIZED": unknown;
	"session/CLEAR_SESSION": {
		shouldReload: boolean;
	};
	"session/CREDENTIALS_CHANGED": unknown;
	"session/FACEBOOK_AUTHORIZED": {
		accessToken: string;
	};
	"session/FACEBOOK_DEAUTHORIZED": void;
	"session/LOADED_NOT_LOGGED_IN": void;
	"session/LOGIN_FAIL": {
		error: Error;
	};
	"session/LOGIN_SUCCESS": Partial<SessionState>;
	"session/LOGIN_VIA_OAUTH2": {
		code: string;
		stateText: string;
	};
	"session/LOGOUT": void;
	"session/OAUTH_HANDOVER": void;
	"session/OAUTH_LOGIN": {
		path: string;
		queryParams: Record<string, string>;
	};
	"session/OAUTH_SIGNUP": void;
	"session/RECEIVED_COUNTRY_CODE": {
		countryCode: string;
	};
	"session/REFRESH_USER_SESSION": {
		session: Partial<SessionState>;
		shouldReload: boolean;
	};
	"session/REFRESH_USER_SESSION_COMPLETE": void;
	"session/RESTORE_AND_REFRESH_USER_SESSION": void;
	"session/SET_CLIENT_UNIQUE_KEY": {
		clientUniqueKey: string;
	};
	"session/SET_UTM_PARAMETERS": unknown;
	"session/START_POLLING": void;
	"session/STOP_POLLING": void;
	"session/TOGGLE_SHOW_DESKTOP_RELEASE_NOTES": unknown;
	"session/TOGGLE_SHOW_RELEASE_NOTES": {
		showReleaseNotes: boolean;
	};
	// #endregion

	// #region settings
	"settings/DESKTOP_SETTINGS_UPDATED": SettingsState["desktop"];
	"settings/SET_AUDIO_SPECTRUM_ENABLED": SettingsState["audioSpectrumEnabled"];
	"settings/SET_AUTOPLAY": SettingsState["autoPlay"];
	"settings/SET_AUTOSTART_MODE": SettingsState["desktop"]["autoStartMode"];
	"settings/SET_EXPLICIT_CONTENT_TOGGLE": { isEnabled: SettingsState["explicitContentEnabled"] };
	"settings/SET_LANGUAGE": SettingsState["language"];
	"settings/SET_OPEN_LINKS_IN_DESKTOP_APP": SettingsState["openLinksInDesktopApp"];
	"settings/SET_STREAMING_QUALITY": SettingsState["quality"]["streaming"];
	"settings/TOGGLE_AUTOPLAY": void;
	"settings/TOGGLE_CLOSE_TO_TRAY": void;
	"settings/TOGGLE_NORMALIZATION": void;
	"settings/UPDATE_STATE_FROM_LOCAL_STORAGE": Partial<SettingsState>;
	"settings/WEB_UPDATE_AVAILABLE": void;
	// #endregion

	// #region speech
	"speech/PARSE_VOICE_COMMAND": string;
	"speech/START_RECOGNITION": void;
	"speech/STOP_RECOGNITION": void;
	// #endregion

	// #region tidalApi
	"tidalApi/config/middlewareRegistered": unknown;
	"tidalApi/executeMutation/fulfilled": unknown;
	"tidalApi/executeMutation/pending": unknown;
	"tidalApi/executeMutation/rejected": unknown;
	"tidalApi/executeQuery/fulfilled": unknown;
	"tidalApi/executeQuery/pending": unknown;
	"tidalApi/executeQuery/rejected": unknown;
	"tidalApi/internalSubscriptions/subscriptionsUpdated": unknown;
	"tidalApi/invalidateTags": unknown;
	"tidalApi/invalidation/updateProvidedBy": unknown;
	"tidalApi/mutations/removeMutationResult": unknown;
	"tidalApi/queries/cacheEntriesUpserted": unknown;
	"tidalApi/queries/queryResultPatched": unknown;
	"tidalApi/queries/removeQueryResult": unknown;
	"tidalApi/resetApiState": unknown;
	"tidalApi/subscriptions/internal_getRTKQSubscriptions": unknown;
	"tidalApi/subscriptions/unsubscribeQueryResult": unknown;
	"tidalApi/subscriptions/updateSubscriptionOptions": unknown;
	// #endregion

	// #region tidalOpenPlatformApi
	"tidalOpenPlatformApi/config/middlewareRegistered": unknown;
	"tidalOpenPlatformApi/executeMutation/fulfilled": unknown;
	"tidalOpenPlatformApi/executeMutation/pending": unknown;
	"tidalOpenPlatformApi/executeMutation/rejected": unknown;
	"tidalOpenPlatformApi/executeQuery/fulfilled": unknown;
	"tidalOpenPlatformApi/executeQuery/pending": unknown;
	"tidalOpenPlatformApi/executeQuery/rejected": unknown;
	"tidalOpenPlatformApi/internalSubscriptions/subscriptionsUpdated": unknown;
	"tidalOpenPlatformApi/invalidateTags": unknown;
	"tidalOpenPlatformApi/invalidation/updateProvidedBy": unknown;
	"tidalOpenPlatformApi/mutations/removeMutationResult": unknown;
	"tidalOpenPlatformApi/queries/cacheEntriesUpserted": unknown;
	"tidalOpenPlatformApi/queries/queryResultPatched": unknown;
	"tidalOpenPlatformApi/queries/removeQueryResult": unknown;
	"tidalOpenPlatformApi/resetApiState": unknown;
	"tidalOpenPlatformApi/subscriptions/internal_getRTKQSubscriptions": unknown;
	"tidalOpenPlatformApi/subscriptions/unsubscribeQueryResult": unknown;
	"tidalOpenPlatformApi/subscriptions/updateSubscriptionOptions": unknown;
	// #endregion

	// #region tidalPublicApi
	"tidalPublicApi/config/middlewareRegistered": unknown;
	"tidalPublicApi/executeMutation/fulfilled": unknown;
	"tidalPublicApi/executeMutation/pending": unknown;
	"tidalPublicApi/executeMutation/rejected": unknown;
	"tidalPublicApi/executeQuery/fulfilled": unknown;
	"tidalPublicApi/executeQuery/pending": unknown;
	"tidalPublicApi/executeQuery/rejected": unknown;
	"tidalPublicApi/internalSubscriptions/subscriptionsUpdated": unknown;
	"tidalPublicApi/invalidateTags": unknown;
	"tidalPublicApi/invalidation/updateProvidedBy": unknown;
	"tidalPublicApi/mutations/removeMutationResult": unknown;
	"tidalPublicApi/queries/cacheEntriesUpserted": unknown;
	"tidalPublicApi/queries/queryResultPatched": unknown;
	"tidalPublicApi/queries/removeQueryResult": unknown;
	"tidalPublicApi/resetApiState": unknown;
	"tidalPublicApi/subscriptions/internal_getRTKQSubscriptions": unknown;
	"tidalPublicApi/subscriptions/unsubscribeQueryResult": unknown;
	"tidalPublicApi/subscriptions/updateSubscriptionOptions": unknown;
	// #endregion

	// #region trackPrompts
	"trackPrompts/DELETE_ALL_PROMPTS": unknown;
	"trackPrompts/FETCH_TRACK_PROMPTS_FAIL": unknown;
	"trackPrompts/FETCH_TRACK_PROMPTS_SUCCESS": {
		data: BasePrompt[];
	};
	"trackPrompts/GENERATE_SHARE_IMAGES": unknown;
	"trackPrompts/GET_PROMPTS_SETTINGS": unknown;
	"trackPrompts/PLAY_MY_PICKS_ITEM": unknown;
	"trackPrompts/REMOVE_TRACK_FOR_PROMPT": {
		promptId: number | string;
		userId: ItemId;
	};
	"trackPrompts/SET_HAS_SEARCHED": unknown;
	"trackPrompts/SET_TRACK_FOR_PROMPT": {
		promptId: number;
		trn: string;
		userId: ItemId;
	};
	"trackPrompts/SET_TRACK_SEARCH_PHRASE": string;
	"trackPrompts/STORE_GENERATED_SHARE_IMAGES": unknown;
	"trackPrompts/TOGGLE_PROMPTS": "DISABLE" | "ENABLE";
	"trackPrompts/TOGGLE_PROMPTS_SUCCESS": "DISABLE" | "ENABLE";
	// #endregion

	// #region user
	"user/DELETE_PROFILE_PICTURE_BUTTON_CLICKED": void;
	"user/FACEBOOK_PICTURE_BUTTON_CLICKED": void;
	"user/FETCH_PROFILE_PICTURE_AFTER_UPLOAD": {
		shouldDelete: boolean;
		userId: number;
	};
	"user/LOAD_ONBOARDING_STEPS": void;
	"user/LOAD_ONBOARDING_STEPS_FAIL": {
		error: any;
	};
	"user/LOAD_ONBOARDING_STEPS_SUCCESS": {
		steps: OnboardingStep[];
	};
	"user/LOAD_USER": void;
	"user/LOAD_USER_FAIL": {
		error: string;
	};
	"user/LOAD_USER_SUCCESS": {
		clients: UserClient[];
		meta: UserMeta;
		subscription: UserSubscription;
	};
	"user/MARK_ONBOARDING_STEP_AS_SHOWN": {
		step: OnboardingStep;
	};
	"user/MARK_ONBOARDING_STEP_AS_SHOWN_FAIL": {
		step: OnboardingStep;
	};
	"user/MARK_ONBOARDING_STEP_AS_SHOWN_SUCCESS": {
		step: OnboardingStep;
	};
	"user/PROFILE_PICTURE_UPLOAD_SUCCESS": {
		resourceId: string;
	};
	"user/RECEIVED_FACEBOOK_LOGIN_TOKEN_FOR_DESKTOP": unknown;
	"user/RECEIVED_FACEBOOK_LOGIN_TOKEN_FOR_PROFILE_PICTURE_FOR_DESKTOP": unknown;
	"user/RECEIVED_SNAPCHAT_ACCESS_TOKEN": string;
	"user/RECEIVED_TIKTOK_ACCESS_TOKEN": string;
	"user/REGISTER_FACEBOOK_USER": {
		id: number;
	};
	"user/REGISTER_UNKNOWN_FACEBOOK_USER": void;
	"user/REMOVE_SOCIAL_CSRF_TOKEN": unknown;
	"user/SET_IS_LOADING": unknown;
	"user/SNAPCHAT_PICTURE_BUTTON_CLICKED": unknown;
	"user/STORE_SOCIAL_CSRF_TOKEN": unknown;
	"user/TEMPORARY_DISABLE_ARTIST_PICKER": void;
	"user/TIKTOK_PICTURE_BUTTON_CLICKED": unknown;
	"user/UNREGISTER_FACEBOOK_USER_SUCCESS": void;
	"user/UPDATE_EAP_STATUS": unknown;
	"user/UPDATE_PROFILE_NAME": string;
	"user/UPDATE_PROFILE_NAME_SUCCESS": string;
	"user/UPDATE_PROFILE_PICTURE": {
		file: File;
	};
	"user/UPDATE_PROFILE_SOCIAL_HANDLES": unknown;
	// #endregion

	// #region userProfiles
	"userProfiles/CHECK_ONBOARDING_STATUS": void;
	"userProfiles/FETCH_TRACK_PROMPTS": ItemId;
	"userProfiles/FETCH_USER_PROFILE": {
		userId: number;
	};
	"userProfiles/FETCH_USER_PROFILE_DATA": {
		dataType: UserProfileDataTypes;
		reset?: boolean;
		userId?: ItemId;
	};
	"userProfiles/FETCH_USER_PROFILE_DATA_SUCCESS": {
		data: unknown;
		dataType: UserProfileDataTypes;
		reset?: boolean;
		userId: number;
	};
	"userProfiles/FETCH_USER_PROFILE_FAILURE": number | undefined;
	"userProfiles/FETCH_USER_PROFILE_SUCCESS": UserProfile;
	"userProfiles/INITIALIZE_USER_PROFILE": {
		profileName: string;
		selectionItemIds: ItemId[];
	};
	"userProfiles/REMOVE_PLAYLIST": {
		playlistUuid: ItemId;
		userId: ItemId;
	};
	"userProfiles/TOGGLE_PUBLIC_PLAYLIST": {
		isPublic?: boolean;
		playlistUUID: ItemId;
	};
	// #endregion

	// #region view
	"view/ENTERED_NOWPLAYING": void;
	"view/EXITED_NOWPLAYING": void;
	"view/ENTER_NOWPLAYING": void;
	"view/EXIT_NOWPLAYING": void;
	"view/REQUEST_FULLSCREEN": void;
	"view/EXIT_FULLSCREEN": void;
	"view/EXITED_FULLSCREEN": void;
	"view/FULLSCREEN_ALLOWED": void;
	"view/FULLSCREEN_DENIED": void;
	"view/ENTER_NATIVE_FULLSCREEN": void;
	"view/LEAVE_NATIVE_FULLSCREEN": void;
	"view/MINIMIZE": void;
	"view/HIDE_PLAY_QUEUE_ASIDE": void;
	"view/TOGGLE_PLAY_QUEUE_VISIBILITY": void;
	"view/HIDE_SEARCH_POPOVER": void;
	"view/LEAVE_PORTAL": void;
	"view/SET_HORIZONTAL_LIST_SCROLL_POSITION": unknown;
	"view/SHOW_SEARCH_POPOVER": void;
	"view/SEARCH_FOCUS": void;
	"view/TOGGLE_VISIBILITY": boolean;
	"view/SHOW_FEED_SIDEBAR": void;
	"view/HIDE_FEED_SIDEBAR": void;
	// #endregion
}

// Sneaky helper to validate that the ActionTypes interface implements all ActionType keys
type ValidateActionTypes<T extends Record<ActionType, unknown> & Record<Exclude<keyof T, ActionType>, never>> = T;
type _CheckActionTypes = ValidateActionTypes<ActionPayloads>;
