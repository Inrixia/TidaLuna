import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { interceptors, type LunaUnload } from "@luna/core";

// By path: `test/*` is a vitest alias only, so `tsc` would not resolve these imports
import { mockAction } from "../../../../test/harness/actions";
import { reduxStore, resetTidalState, setTidalState, type TidalState } from "../../../../test/harness/tidalStore";

import * as redux from "../redux";
import { MediaItem } from "./MediaItem";
import { PlayState } from "./PlayState";

/** TIDAL's action creators as `plugins/lib/src/redux/actions.ts` captured them, restored after each test so a mock cannot leak */
const seededActions = { ...redux.actions };

/** The harness store is typed from `defaultTidalState()`, an abbreviated TIDAL store, so a written slice is cast */
const setPlaybackControls = (controls: Partial<redux.PlaybackControls>) =>
	setTidalState({ playbackControls: { ...reduxStore.getState().playbackControls, ...controls } } as unknown as Partial<TidalState>);
const setPlayQueue = (playQueue: Partial<redux.PlayQueue>) =>
	setTidalState({ playQueue: { ...reduxStore.getState().playQueue, ...playQueue } } as unknown as Partial<TidalState>);

/**
 * TIDAL patches its action creators so Luna's interceptors run before an action dispatches
 * (render/src/exposeTidalInternals.patchAction.ts). test/setup-dom.ts seeds plain creators, so this stands in for that
 * pipeline: run every interceptor registered for the type, then apply the state change the action would have made.
 */
const setPlaybackState = (playbackState: redux.PlaybackState) => {
	const type = "playbackControls/SET_PLAYBACK_STATE";
	for (const interceptor of interceptors[type] ?? []) {
		if (interceptor(playbackState, type) === true) return;
	}
	setPlaybackControls({ playbackState });
};

// #region Scrobble plumbing
/** The receiver PlayState hands to `MediaItem.onMediaTransition` (see the top level `beforeAll`) */
let mediaTransition: ((mediaItem: MediaItem) => unknown) | undefined;
/**
 * TIDAL tells PlayState which item playback moved to. Passing no item clears the current one: PlayState's current item
 * is private, and with `cumulativePlaytime` reset its check is a no-op, so nothing is scrobbled by the reset.
 */
const triggerMediaTransition = (mediaItem?: MediaItem) => mediaTransition?.(mediaItem as MediaItem);

/** Only `duration` takes part in the scrobble rules */
const mediaItem = (duration?: number) => ({ duration }) as unknown as MediaItem;

const scrobbles: MediaItem[] = [];
const scrobbleUnloads = new Set<LunaUnload>();

const resetScrobbleState = () => {
	scrobbles.length = 0;
	PlayState.cumulativePlaytime = 0;
	delete PlayState.lastPlayStart;
	triggerMediaTransition(undefined);
};
// #endregion

beforeAll(async () => {
	// PlayState.onScrobble's setup is async and subscribes to MediaItem.onMediaTransition, which is captured here
	vi.spyOn(MediaItem, "fromPlaybackContext").mockResolvedValue(undefined);
	vi.spyOn(MediaItem, "onMediaTransition").mockImplementation((_unloads, receiver) => {
		mediaTransition = receiver;
		return () => {};
	});

	PlayState.onScrobble(scrobbleUnloads, (scrobbled) => {
		scrobbles.push(scrobbled);
	});
	// The receiver is only registered once that setup's await on MediaItem.fromPlaybackContext resolves
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(mediaTransition).toBeDefined();
});

beforeEach(() => {
	resetTidalState();
	PlayState.cumulativePlaytime = 0;
	delete PlayState.lastPlayStart;
});

afterEach(() => {
	vi.useRealTimers();
	Object.assign(redux.actions, seededActions);
});

afterAll(() => {
	for (const unload of scrobbleUnloads) unload();
	vi.restoreAllMocks();
});

describe("accessors", () => {
	test("reads the playback controls", () => {
		const playbackContext = { actualProductId: "123" } as redux.PlaybackContext;
		setPlaybackControls({ playbackState: "PLAYING", desiredPlaybackState: "PAUSED", latestCurrentTime: 42, playbackContext });

		expect(PlayState.playbackControls.playbackState).toBe("PLAYING");
		expect(PlayState.playbackContext).toBe(playbackContext);
		expect(PlayState.state).toBe("PLAYING");
		expect(PlayState.desiredState).toBe("PAUSED");
		expect(PlayState.playTime).toBe(42);
	});

	test("playing follows the desired playback state, not the current one", () => {
		setPlaybackControls({ playbackState: "IDLE", desiredPlaybackState: "PLAYING" });
		expect(PlayState.playing).toBe(true);

		setPlaybackControls({ playbackState: "PLAYING", desiredPlaybackState: "PAUSED" });
		expect(PlayState.playing).toBe(false);
	});

	test("reads the play queue", () => {
		const elements = [{ mediaItemId: 1 }] as unknown as redux.PlayQueueElement[];
		setPlayQueue({ elements, currentIndex: 2, shuffleModeEnabled: true, repeatMode: redux.RepeatMode.One });

		expect(PlayState.playQueue.elements).toBe(elements);
		expect(PlayState.playQueue.currentIndex).toBe(2);
		expect(PlayState.shuffle).toBe(true);
		expect(PlayState.repeatMode).toBe(redux.RepeatMode.One);
	});

	test("currentTime falls back to 0 when TIDAL's player module cannot be found", () => {
		// Nothing in `tidalModules` (empty in tests) carries an `activePlayer`, which is what PlayState looks the module up by
		expect(PlayState.currentTime).toBe(0);
	});
});

describe("shuffle", () => {
	test("setShuffle(true, true) enables shuffle mode and shuffles the items", () => {
		const action = vi.fn();
		mockAction("playQueue/ENABLE_SHUFFLE_MODE_AND_SHUFFLE_ITEMS", action);

		PlayState.setShuffle(true, true);

		expect(action).toHaveBeenCalledTimes(1);
		const { shuffleSeed } = action.mock.calls[0]![0] as { shuffleSeed: number };
		expect(typeof shuffleSeed).toBe("number");
		expect(shuffleSeed).toBeGreaterThanOrEqual(0);
		expect(shuffleSeed).toBeLessThan(1);
	});

	test("setShuffle(false, true) disables shuffle mode and unshuffles the items", () => {
		const action = vi.fn();
		mockAction("playQueue/DISABLE_SHUFFLE_MODE_AND_UNSHUFFLE_ITEMS", action);

		PlayState.setShuffle(false, true);

		expect(action).toHaveBeenCalledTimes(1);
	});

	test("shuffling the items dispatches even when the shuffle mode does not change", () => {
		setPlayQueue({ shuffleModeEnabled: false });
		const enable = vi.fn();
		const disable = vi.fn();
		mockAction("playQueue/ENABLE_SHUFFLE_MODE_AND_SHUFFLE_ITEMS", enable);
		mockAction("playQueue/DISABLE_SHUFFLE_MODE_AND_UNSHUFFLE_ITEMS", disable);

		PlayState.setShuffle(false, true);

		expect(disable).toHaveBeenCalledTimes(1);
		expect(enable).not.toHaveBeenCalled();
	});

	test("setShuffle(true) enables shuffle mode when it is off", () => {
		setPlayQueue({ shuffleModeEnabled: false });
		const enable = vi.fn();
		const disable = vi.fn();
		mockAction("playQueue/ENABLE_SHUFFLE_MODE", enable);
		mockAction("playQueue/DISABLE_SHUFFLE_MODE", disable);

		PlayState.setShuffle(true);

		expect(enable).toHaveBeenCalledTimes(1);
		expect(disable).not.toHaveBeenCalled();
	});

	test("setShuffle(false) disables shuffle mode when it is on", () => {
		setPlayQueue({ shuffleModeEnabled: true });
		const enable = vi.fn();
		const disable = vi.fn();
		mockAction("playQueue/ENABLE_SHUFFLE_MODE", enable);
		mockAction("playQueue/DISABLE_SHUFFLE_MODE", disable);

		PlayState.setShuffle(false);

		expect(disable).toHaveBeenCalledTimes(1);
		expect(enable).not.toHaveBeenCalled();
	});

	test("setShuffle(true) without shuffling the items does nothing when shuffle mode is already on", () => {
		setPlayQueue({ shuffleModeEnabled: true });
		const enable = vi.fn();
		const disable = vi.fn();
		mockAction("playQueue/ENABLE_SHUFFLE_MODE", enable);
		mockAction("playQueue/DISABLE_SHUFFLE_MODE", disable);

		PlayState.setShuffle(true);

		expect(enable).not.toHaveBeenCalled();
		expect(disable).not.toHaveBeenCalled();
	});

	test("setShuffle(false) without shuffling the items does nothing when shuffle mode is already off", () => {
		setPlayQueue({ shuffleModeEnabled: false });
		const enable = vi.fn();
		const disable = vi.fn();
		mockAction("playQueue/ENABLE_SHUFFLE_MODE", enable);
		mockAction("playQueue/DISABLE_SHUFFLE_MODE", disable);

		PlayState.setShuffle(false);

		expect(enable).not.toHaveBeenCalled();
		expect(disable).not.toHaveBeenCalled();
	});
});

describe("repeat mode", () => {
	test("RepeatMode is TIDAL's RepeatMode", () => {
		expect(PlayState.RepeatMode).toBe(redux.RepeatMode);
	});

	test("setRepeatMode dispatches the mode", () => {
		const action = vi.fn();
		mockAction("playQueue/SET_REPEAT_MODE", action);

		PlayState.setRepeatMode(redux.RepeatMode.All);

		expect(action).toHaveBeenCalledTimes(1);
		expect(action).toHaveBeenCalledWith(redux.RepeatMode.All);
	});

	test("repeatMode reads the play queue", () => {
		expect(PlayState.repeatMode).toBe(redux.RepeatMode.Off);
		setPlayQueue({ repeatMode: redux.RepeatMode.One });
		expect(PlayState.repeatMode).toBe(redux.RepeatMode.One);
	});
});

describe("playback", () => {
	test("play() plays what is already loaded", () => {
		const addNext = vi.fn();
		const moveNext = vi.fn();
		const play = vi.fn();
		mockAction("playQueue/ADD_NEXT", addNext);
		mockAction("playQueue/MOVE_NEXT", moveNext);
		mockAction("playbackControls/PLAY", play);

		PlayState.play();

		expect(play).toHaveBeenCalledTimes(1);
		expect(addNext).not.toHaveBeenCalled();
		expect(moveNext).not.toHaveBeenCalled();
	});

	test("play(mediaItemId) queues the item, moves to it and then plays", () => {
		const order: string[] = [];
		const addNext = vi.fn(() => void order.push("ADD_NEXT"));
		mockAction("playQueue/ADD_NEXT", addNext);
		mockAction("playQueue/MOVE_NEXT", () => void order.push("MOVE_NEXT"));
		mockAction("playbackControls/PLAY", () => void order.push("PLAY"));

		PlayState.play(42);

		expect(addNext).toHaveBeenCalledWith({ mediaItemIds: [42], context: { type: "UNKNOWN" } });
		expect(order).toEqual(["ADD_NEXT", "MOVE_NEXT", "PLAY"]);
	});

	test("pause() pauses", () => {
		const action = vi.fn();
		mockAction("playbackControls/PAUSE", action);

		PlayState.pause();

		expect(action).toHaveBeenCalledTimes(1);
	});

	test("next() moves the queue on", () => {
		const action = vi.fn();
		mockAction("playQueue/MOVE_NEXT", action);

		PlayState.next();

		expect(action).toHaveBeenCalledTimes(1);
	});

	test("previous() moves the queue back", () => {
		const action = vi.fn();
		mockAction("playQueue/MOVE_PREVIOUS", action);

		PlayState.previous();

		expect(action).toHaveBeenCalledTimes(1);
	});

	test("moveTo() moves to the given queue index", () => {
		const action = vi.fn();
		mockAction("playQueue/MOVE_TO", action);

		PlayState.moveTo(3);

		expect(action).toHaveBeenCalledWith(3);
	});

	test("seek() seeks to the given time", () => {
		const action = vi.fn();
		mockAction("playbackControls/SEEK", action);

		PlayState.seek(12.5);

		expect(action).toHaveBeenCalledWith(12.5);
	});

	test("playNext() queues a single id as an unknown context item", () => {
		const action = vi.fn();
		mockAction("playQueue/ADD_NEXT", action);

		PlayState.playNext("42");

		expect(action).toHaveBeenCalledWith({ mediaItemIds: ["42"], context: { type: "UNKNOWN" } });
	});

	test("playNext() queues every id it is given", () => {
		const action = vi.fn();
		mockAction("playQueue/ADD_NEXT", action);
		const mediaItemIds: redux.ItemId[] = ["1", 2, "3"];

		PlayState.playNext(mediaItemIds);

		expect(action).toHaveBeenCalledWith({ mediaItemIds, context: { type: "UNKNOWN" } });
		// The ids are passed through as given, not copied
		expect((action.mock.calls[0]![0] as { mediaItemIds: redux.ItemId[] }).mediaItemIds).toBe(mediaItemIds);
	});

	test("updatePlayQueue() resets the queue with the current queue merged over", () => {
		const elements = [{ mediaItemId: 1 }, { mediaItemId: 2 }] as unknown as redux.PlayQueueElement[];
		setPlayQueue({ elements, currentIndex: 0, repeatMode: redux.RepeatMode.All, shuffleModeEnabled: true });
		const currentQueue = reduxStore.getState().playQueue;
		const action = vi.fn();
		mockAction("playQueue/RESET", action);

		PlayState.updatePlayQueue({ currentIndex: 1 });

		expect(action).toHaveBeenCalledTimes(1);
		const reset = action.mock.calls[0]![0] as redux.PlayQueue;
		expect(reset).toEqual({ ...currentQueue, currentIndex: 1 });
		// The queue's own contents are kept, only the patched field changes
		expect(reset.elements).toBe(elements);
		expect(reset.repeatMode).toBe(redux.RepeatMode.All);
		expect(reset.shuffleModeEnabled).toBe(true);
	});
});

describe("playtime accounting", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		resetScrobbleState();
	});

	test("PLAYING records the time playback started", () => {
		setPlaybackState("PLAYING");

		expect(PlayState.lastPlayStart).toBe(1000);
		expect(PlayState.cumulativePlaytime).toBe(0);
	});

	test("a state other than PLAYING adds the time since playback started", () => {
		setPlaybackState("PLAYING");
		vi.advanceTimersByTime(5000);

		setPlaybackState("PAUSED");

		expect(PlayState.cumulativePlaytime).toBe(5000);
		expect(PlayState.lastPlayStart).toBeUndefined();
	});

	test("accumulates across play and pause cycles without counting paused time", () => {
		setPlaybackState("PLAYING");
		vi.advanceTimersByTime(3000);
		setPlaybackState("PAUSED");
		expect(PlayState.cumulativePlaytime).toBe(3000);

		// Ten seconds paused
		vi.advanceTimersByTime(10000);
		setPlaybackState("PLAYING");
		vi.advanceTimersByTime(2000);
		setPlaybackState("IDLE");

		expect(PlayState.cumulativePlaytime).toBe(5000);
		expect(PlayState.lastPlayStart).toBeUndefined();
	});

	test("a state change without a preceding PLAYING adds nothing", () => {
		setPlaybackState("STALLED");

		expect(PlayState.cumulativePlaytime).toBe(0);
		expect(PlayState.lastPlayStart).toBeUndefined();
	});

	test("a second PLAYING restarts the start time without adding the time already played", () => {
		setPlaybackState("PLAYING");
		vi.advanceTimersByTime(5000);

		setPlaybackState("PLAYING");

		expect(PlayState.lastPlayStart).toBe(6000);
		expect(PlayState.cumulativePlaytime).toBe(0);
	});
});

describe("scrobbling", () => {
	beforeEach(() => {
		resetScrobbleState();
	});

	test.each([
		["scrobbles a long track after 4 minutes of playtime", 700, 240000, true],
		["does not scrobble a long track after just under 4 minutes", 700, 239999, false],
		["scrobbles a short track after half its duration", 60, 30000, true],
		["does not scrobble a short track after just under half its duration", 60, 29999, false],
		["scrobbles a long track after half its duration", 700, 350000, true],
	] as const)("%s", (_, duration, cumulativePlaytime, expected) => {
		const played = mediaItem(duration);
		triggerMediaTransition(played);
		PlayState.cumulativePlaytime = cumulativePlaytime;

		triggerMediaTransition(mediaItem(200));

		expect(scrobbles).toEqual(expected ? [played] : []);
	});

	test("the playtime starts over for the next track", () => {
		const played = mediaItem(600);
		triggerMediaTransition(played);
		PlayState.cumulativePlaytime = PlayState.MIN_SCROBBLE_DURATION;

		triggerMediaTransition(mediaItem(200));

		expect(scrobbles).toEqual([played]);
		expect(PlayState.cumulativePlaytime).toBe(0);
	});

	test("does not scrobble a track whose duration is unknown", () => {
		triggerMediaTransition(mediaItem(undefined));
		PlayState.cumulativePlaytime = PlayState.MIN_SCROBBLE_DURATION * 10;

		triggerMediaTransition(mediaItem(200));

		expect(scrobbles).toEqual([]);
	});

	test("scrobbles a track only once", () => {
		const played = mediaItem(600);
		triggerMediaTransition(played);
		PlayState.cumulativePlaytime = PlayState.MIN_SCROBBLE_DURATION;

		setPlaybackState("IDLE");
		expect(scrobbles).toEqual([played]);

		setPlaybackState("IDLE");
		// Moving on after the scrobble does not scrobble the same track again either
		triggerMediaTransition(mediaItem(200));
		expect(scrobbles).toEqual([played]);
	});

	test("scrobbling starts over for the next track", () => {
		const first = mediaItem(600);
		const second = mediaItem(600);
		triggerMediaTransition(first);
		PlayState.cumulativePlaytime = PlayState.MIN_SCROBBLE_DURATION;
		triggerMediaTransition(second);
		expect(scrobbles).toEqual([first]);

		PlayState.cumulativePlaytime = PlayState.MIN_SCROBBLE_DURATION;
		triggerMediaTransition(mediaItem(600));

		expect(scrobbles).toEqual([first, second]);
	});

	test("IDLE at the end of the queue scrobbles the current track", () => {
		const played = mediaItem(600);
		triggerMediaTransition(played);
		PlayState.cumulativePlaytime = PlayState.MIN_SCROBBLE_DURATION;

		setPlaybackState("IDLE");

		expect(scrobbles).toEqual([played]);
	});

	test("IDLE without a current track scrobbles nothing", () => {
		PlayState.cumulativePlaytime = PlayState.MIN_SCROBBLE_DURATION * 10;

		setPlaybackState("IDLE");

		expect(scrobbles).toEqual([]);
	});

	test("counts the playtime of a track that is still playing when it ends", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const played = mediaItem(600);
		triggerMediaTransition(played);
		setPlaybackState("PLAYING");
		vi.advanceTimersByTime(PlayState.MIN_SCROBBLE_DURATION);

		// A transition while still PLAYING never passed through a state change that would bank the playtime
		triggerMediaTransition(mediaItem(200));

		expect(scrobbles).toEqual([played]);
		expect(PlayState.lastPlayStart).toBe(1000);
		expect(PlayState.cumulativePlaytime).toBe(0);
	});

	test("a track that ends before either threshold is not scrobbled", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const played = mediaItem(600);
		triggerMediaTransition(played);
		setPlaybackState("PLAYING");
		vi.advanceTimersByTime(1000);

		triggerMediaTransition(mediaItem(200));

		expect(scrobbles).toEqual([]);
	});

	test("scrobbles playtime that a state change banked before the transition", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const played = mediaItem(60);
		triggerMediaTransition(played);
		setPlaybackState("PLAYING");
		vi.advanceTimersByTime(30000);

		setPlaybackState("PAUSED");
		expect(PlayState.cumulativePlaytime).toBe(30000);

		// 30s of a 60s track, banked before the transition, is still half of it
		triggerMediaTransition(mediaItem(200));

		expect(scrobbles).toEqual([played]);
	});
});
