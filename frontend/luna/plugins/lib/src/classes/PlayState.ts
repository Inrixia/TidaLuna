import { registerEmitter, type AddReceiver, type MaybePromise, type VoidLike } from "@inrixia/helpers";

import { findModuleByProperty, type Tracer } from "@luna/core";

import { libTrace, unloads } from "../index.safe";
import * as redux from "../redux";
import { MediaItem } from "./MediaItem";

export class PlayState {
	/**
	 * The minimum duration of a track that needs to be played before it can be scrobbled.
	 * Defaults to 4 minutes in milliseconds
	 */
	public static readonly MIN_SCROBBLE_DURATION = 240000;
	/**
	 * The minimum percentage of a track that needs to be played before it can be scrobbled.
	 * Defaults to 0.5 (50%)
	 */
	public static readonly MIN_SCROBBLE_PERCENTAGE = 0.5;

	/**
	 * The total time the current track has been played in milliseconds
	 * Note: Can be longer than track duration, use `PlayState.playTime` to get the current play time
	 */
	public static cumulativePlaytime: number = 0;
	/**
	 * The time the last track started playing epoch ms
	 */
	public static lastPlayStart?: number;

	private static readonly trace: Tracer = libTrace.withSource(".PlayState").trace;
	private static activePlayer?: { currentTime: number };

	public static get playbackControls() {
		return redux.store.getState().playbackControls;
	}
	public static get playbackContext() {
		return this.playbackControls.playbackContext;
	}

	public static get playQueue() {
		return redux.store.getState().playQueue;
	}

	/**
	 * The current playback position in seconds from the active player.
	 * Unlike `playTime` (from Redux state), this is the live player position.
	 */
	public static get currentTime(): number {
		if (this.activePlayer === undefined) {
			const mod = findModuleByProperty<{ activePlayer: { currentTime: number } }>((key, value) => key === "activePlayer" && typeof value === "object" && value !== null && "currentTime" in value);
			this.activePlayer = mod?.activePlayer;
		}
		return this.activePlayer?.currentTime ?? 0;
	}
	public static nextMediaItem() {
		const nextItemId = this.playQueue.elements[this.playQueue.currentIndex + 1]?.mediaItemId;
		return MediaItem.fromId(nextItemId);
	}
	public static previousMediaItem() {
		const previousMediaItem = this.playQueue.elements[this.playQueue.currentIndex - 1]?.mediaItemId;
		return MediaItem.fromId(previousMediaItem);
	}

	public static get state() {
		return this.playbackControls.playbackState;
	}
	public static get desiredState() {
		return this.playbackControls.desiredPlaybackState;
	}

	// #region Shuffle
	public static get shuffle(): boolean {
		return this.playQueue.shuffleModeEnabled;
	}
	public static setShuffle(shuffle: false, unshuffleItems?: boolean): void;
	public static setShuffle(shuffle: true, shuffleItems?: boolean): void;
	public static setShuffle(shuffle: boolean, shuffleItems: boolean = false): MaybePromise<VoidLike> {
		if (shuffleItems)
			return shuffle
				? redux.actions["playQueue/ENABLE_SHUFFLE_MODE_AND_SHUFFLE_ITEMS"]({
					shuffleSeed: Math.random(),
				})
				: redux.actions["playQueue/DISABLE_SHUFFLE_MODE_AND_UNSHUFFLE_ITEMS"]();

		if (shuffle !== this.shuffle) shuffle ? redux.actions["playQueue/ENABLE_SHUFFLE_MODE"]() : redux.actions["playQueue/DISABLE_SHUFFLE_MODE"]();
	}
	// #endregion

	// #region Repeat
	public static RepeatMode = redux.RepeatMode;
	public static get repeatMode(): redux.RepeatMode {
		return this.playQueue.repeatMode;
	}
	public static setRepeatMode(repeatMode: redux.RepeatMode): void {
		redux.actions["playQueue/SET_REPEAT_MODE"](repeatMode);
	}
	// #endregion

	// #region Playback
	public static get playing(): boolean {
		return this.desiredState === "PLAYING";
	}
	/**
	 * Play the current track, or a specific track if mediaItemId is provided.
	 * mediaItemId is not validated, you should use `MediaItem.play`
	 *
	 * If `mediaItemId` is provided, equivilent to:
	 * ```ts
	 * PlayState.playNext(mediaItemId);
	 * PlayState.next();
	 * PlayState.play();
	 * ```
	 */
	public static play(mediaItemId?: redux.ItemId) {
		if (mediaItemId !== undefined) {
			this.playNext(mediaItemId);
			this.next();
		}
		redux.actions["playbackControls/PLAY"]();
	}
	public static pause() {
		redux.actions["playbackControls/PAUSE"]();
	}
	/**
	 * Skip to the next track
	 */
	public static next() {
		redux.actions["playQueue/MOVE_NEXT"]();
	}
	/**
	 * Skip to the previous track
	 */
	public static previous() {
		redux.actions["playQueue/MOVE_PREVIOUS"]();
	}
	/**
	 * Move to a specific track in the play queue
	 * @param playQueueIndex The index of the track in the play queue
	 */
	public static moveTo(playQueueIndex: number) {
		redux.actions["playQueue/MOVE_TO"](playQueueIndex);
	}
	/**
	 * Adds `mediaItemIds` to playQueue after current track as temporary items (removed after played)
	 */
	public static playNext(mediaItemIds: redux.ItemId | redux.ItemId[]) {
		mediaItemIds = Array.isArray(mediaItemIds) ? mediaItemIds : [mediaItemIds];
		redux.actions["playQueue/ADD_NEXT"]({ mediaItemIds, context: { type: "UNKNOWN" } });
	}
	/**
	 * Updeates PlayState.playQueue, note this may cause playback to restart
	 */
	public static updatePlayQueue(playQueue: Partial<redux.PlayQueue>) {
		redux.actions["playQueue/RESET"]({
			...PlayState.playQueue,
			...playQueue,
		});
	}
	// #endregion

	// #region Seek
	public static get playTime() {
		return this.playbackControls.latestCurrentTime;
	}
	public static seek(time: number) {
		redux.actions["playbackControls/SEEK"](time);
	}
	// #endregion

	static {
		// State tracking for scrobbling
		redux.intercept("playbackControls/SET_PLAYBACK_STATE", unloads, (state) => {
			switch (state) {
				case "PLAYING": {
					this.lastPlayStart = Date.now();
					break;
				}
				default: {
					if (this.lastPlayStart !== undefined) this.cumulativePlaytime += Date.now() - this.lastPlayStart;
					delete this.lastPlayStart;
				}
			}
		});

		// Preserve current track when clearing queue
		let blockAutoPlay = false;
		const playActions = ["playbackControls/PLAY", "mix/PLAY_MIX", "playQueue/ADD_NOW", "playQueue/ADD_TRACK_LIST_TO_PLAY_QUEUE"] as const;
		for (const action of playActions) {
			redux.intercept(action, unloads, () => blockAutoPlay);
		}

		redux.intercept("playQueue/CLEAR_QUEUE", unloads, () => {
			const { elements, currentIndex } = this.playQueue;
			const currentElement = elements[currentIndex];
			if (!currentElement) return;

			blockAutoPlay = true;
			redux.actions["playbackControls/STOP"]();
			redux.actions["view/HIDE_PLAY_QUEUE_ASIDE"]();
			redux.actions["playQueue/RESET"]({ elements: [currentElement], currentIndex: 0 });
			setTimeout(() => (blockAutoPlay = false), 1000);

			return true;
		});
	}

	private static currentMediaItem?: MediaItem;
	/**
	 * Triggered on MediaItem.onMediaTransition and when a track should be scrobbled according to `MIN_SCROBBLE_DURATION` and `MIN_SCROBBLE_PERCENTAGE`
	 */
	public static onScrobble: AddReceiver<MediaItem> = registerEmitter(async (onScrobble) => {
		this.currentMediaItem = await MediaItem.fromPlaybackContext();
		MediaItem.onMediaTransition(unloads, (mediaItem) => {
			// Dont use mediaItem as its the NEXT track not the one we just finished listening to
			const isRepeating = this.repeatMode === this.RepeatMode.One;
			if (this.currentMediaItem !== undefined && (!isRepeating && (this.currentMediaItem.id !== mediaItem.id))) {
				if (this.currentMediaItem.duration === undefined) return;
				if (this.lastPlayStart !== undefined) this.cumulativePlaytime += Date.now() - this.lastPlayStart;
				const longerThan4min = this.cumulativePlaytime >= this.MIN_SCROBBLE_DURATION;
				const minPlayTime = this.currentMediaItem.duration * this.MIN_SCROBBLE_PERCENTAGE * 1000;
				const moreThan50Percent = this.cumulativePlaytime >= minPlayTime;
				if (longerThan4min || moreThan50Percent) onScrobble(this.currentMediaItem, this.trace.err.withContext("onScrobble"));
			}
			this.currentMediaItem = mediaItem;
			// reset as we started playing a new one
			this.cumulativePlaytime = 0;
		});
	});

	/** Triggered on "playbackControls/SET_PLAYBACK_STATE" */
	public static onState: AddReceiver<redux.PlaybackState> = registerEmitter((onState) =>
		redux.intercept("playbackControls/SET_PLAYBACK_STATE", unloads, (playbackState) =>
			onState(playbackState, this.trace.err.withContext("onState")),
		),
	);
}
