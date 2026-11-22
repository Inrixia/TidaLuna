/**
 * Bridge to communicate with tidal-hifi's main process via IPC.
 *
 * Tested OK:
 * - MPRIS
 * - Discord Rich Presence
 * - Desktop notifications
 * - Skip Artists
 * - Tray icon
 * - Web API
 * - Custom CSS and themes injection
 * - Custom hotkeys
 * - Tidal channel/URL
 * - Static/dynamic window title
 * - Single instance
 * - Custom tray icon path
 * - Block ads
	* - Flags
 *
 * Not working:
 * - ListenBrainz scrobbling — tidal-hifi does not send API requests despite receiving correct data.
 */
import { MediaItem, PlayState, redux } from "@luna/lib";
import { linuxTrace, unloads } from "./index.safe";

linuxTrace.log("tidal-hifi bridge enabled");

// #region Utilities

const getTidalHifiSetting = <T = unknown>(key: string): Promise<T | undefined> =>
	__ipcRenderer.invoke("__Luna.getTidalHifiSetting", key).catch(() => undefined);

const safeNum = (v: unknown): number => {
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : 0;
};

const formatTime = (seconds: number): string => {
	const s = safeNum(seconds);
	const m = Math.floor(s / 60);
	const sec = Math.floor(s % 60);
	return `${m}:${sec.toString().padStart(2, "0")}`;
};

const mapRepeat = (mode: redux.RepeatMode) => (mode === redux.RepeatMode.One ? "single" : mode === redux.RepeatMode.All ? "all" : "off");

const injectCSS = (css: string) => {
	const style = document.createElement("style");
	style.innerHTML = css;
	document.head.appendChild(style);
};

const cycleRepeatMode = () => {
	const modes = [redux.RepeatMode.Off, redux.RepeatMode.All, redux.RepeatMode.One];
	PlayState.setRepeatMode(modes[(modes.indexOf(PlayState.repeatMode) + 1) % modes.length]);
};

// "Now playing" notifications share a tag, so each track's one replaces the previous one instead of piling up (#210)
let trackNotification: Notification | undefined;
unloads.add(() => trackNotification?.close());

const sendNotification = (title: string, body: string, icon?: string, replacesTrack = false) => {
	const show = () => {
		if (!replacesTrack) return new Notification(title, { body, icon });
		trackNotification = new Notification(title, { body, icon, tag: "luna-now-playing" });
	};
	if (Notification.permission === "granted") {
		show();
	} else if (Notification.permission !== "denied") {
		Notification.requestPermission().then((p) => p === "granted" && show());
	}
};

// #endregion

// #region CSS & Themes

(async () => {
	try {
		const theme = await getTidalHifiSetting<string>("theme");
		if (theme && theme !== "none") {
			const themeCSS = await __ipcRenderer.invoke("__Luna.getTidalHifiThemeCSS", theme).catch(() => undefined);
			if (themeCSS) {
				injectCSS(themeCSS);
				linuxTrace.log("Injected theme:", theme);
			}
		}

		const customCSS = await getTidalHifiSetting<string[]>("customCSS");
		if (customCSS?.length) {
			injectCSS(customCSS.join("\n"));
			linuxTrace.log("Injected custom CSS");
		}
	} catch (err) {
		linuxTrace.err.withContext("tidalHifi.customCSS")(err);
	}
})();

// #endregion

// #region Media Info

let lastId: string | number | undefined;
let lastInfo: Record<string, unknown> = {};

const sendUpdateInfo = (status: string, currentSec = safeNum(PlayState.currentTime)) => {
	__ipcRenderer.send("update-info", {
		...lastInfo,
		status,
		currentInSeconds: currentSec,
		current: formatTime(currentSec),
		player: { status, shuffle: PlayState.shuffle ?? false, repeat: mapRepeat(PlayState.repeatMode) },
	});
};

MediaItem.onMediaTransition(unloads, async (item) => {
	if (item.id === lastId) return;
	lastId = item.id;

	try {
		// TIDAL's own metadata first, title() and artists() wait on MusicBrainz which can take seconds
		const tidalArtists = <string[]>(item.tidalItem.artists?.map((a) => a?.name).filter(Boolean) ?? []);
		setInfo(item, item.tidalItem.title ?? "Unknown", tidalArtists.join(", ") || "Unknown", "", "");

		// Window title
		const staticTitle = await getTidalHifiSetting<boolean>("staticWindowTitle");
		document.title = staticTitle ? "TIDAL Hi-Fi" : `${item.tidalItem.title ?? "Unknown"} - ${tidalArtists.join(", ") || "Unknown"}`;

		// Skip artists
		if (await getTidalHifiSetting<boolean>("skipArtists")) {
			const skippedArtists = (await getTidalHifiSetting<string[]>("skippedArtists")) ?? [];
			if (tidalArtists.some((name) => skippedArtists.includes(name))) {
				linuxTrace.log("Skipping artist:", tidalArtists);
				PlayState.next();
				return;
			}
		}

		const [title, artists, album, image] = await Promise.all([
			item.title(),
			item.artists().then((a) => Promise.all(a)),
			item.album().then((album) => album?.title()),
			item.coverUrl({ res: "640" }),
		]);
		if (item.id !== lastId) return;

		const artistStr = artists?.map((a) => a?.name).filter(Boolean).join(", ") || "Unknown";
		setInfo(item, title ?? "Unknown", artistStr, album ?? "", image ?? "");
		if (!staticTitle) document.title = `${title ?? "Unknown"} - ${artistStr}`;
		linuxTrace.log("Sent update-info:", title);

		// Desktop notification
		if (await getTidalHifiSetting<boolean>("notifications")) {
			sendNotification(lastInfo.title as string, artistStr, image ?? undefined, true);
		}
	} catch (err) {
		linuxTrace.err.withContext("tidalHifi.onMediaTransition")(err);
	}
});

function setInfo(item: MediaItem, title: string, artistStr: string, album: string, image: string) {
	const durationSec = safeNum(item.duration);
	const currentSec = safeNum(PlayState.currentTime);
	lastInfo = {
		title,
		artists: artistStr,
		album,
		url: item.url ?? "",
		image,
		icon: image,
		durationInSeconds: durationSec,
		duration: formatTime(durationSec),
		currentInSeconds: currentSec,
		current: formatTime(currentSec),
		status: PlayState.playing ? "playing" : "paused",
		trackId: String(item.id),
		playingFrom: "TIDAL",
		favorite: false,
		player: {
			status: PlayState.playing ? "playing" : "paused",
			shuffle: PlayState.shuffle ?? false,
			repeat: mapRepeat(PlayState.repeatMode),
		},
	};
	__ipcRenderer.send("update-info", lastInfo);
}

PlayState.onState(unloads, (state) => {
	if (!lastInfo.title) return;
	sendUpdateInfo(state === "PLAYING" ? "playing" : "paused");
});

// MPRIS clients extrapolate position and only resync on tidal-hifi's Seeked signal, which it emits when an update-info position jumps.
// Without this a seek (in TIDAL or from MPRIS) shows the old position until the next 5s update
redux.intercept("playbackControls/SEEK", unloads, (time) => {
	if (lastInfo.title && typeof time === "number") sendUpdateInfo(PlayState.playing ? "playing" : "paused", safeNum(time));
});

const updateInterval = setInterval(() => {
	if (!lastInfo.title || !PlayState.playing) return;
	sendUpdateInfo("playing");
}, 5000);
unloads.add(() => clearInterval(updateInterval));

// #endregion

// #region Playback Controls (IPC)

const isSeekPayload = (p: unknown): p is { seconds: number; type: "absolute" | "relative" } =>
	typeof p === "object" && p !== null && typeof (p as { seconds?: unknown }).seconds === "number";

unloads.add(
	__ipcRenderer.on("globalEvent", (action: string, payload?: unknown) => {
		linuxTrace.log("globalEvent:", action);
		switch (action) {
			case "play": PlayState.play(); break;
			case "pause": PlayState.pause(); break;
			case "playPause": PlayState.playing ? PlayState.pause() : PlayState.play(); break;
			case "next": PlayState.next(); break;
			case "previous": PlayState.previous(); break;
			case "toggleShuffle": PlayState.shuffle ? PlayState.setShuffle(false, true) : PlayState.setShuffle(true, true); break;
			case "toggleRepeat": cycleRepeatMode(); break;
			case "seek": {
				// tidal-hifi sends { seconds, type: "absolute" (SetPosition) | "relative" (Seek) }, older versions a plain number
				if (typeof payload === "number") PlayState.seek(payload);
				else if (isSeekPayload(payload)) PlayState.seek(Math.max(0, payload.type === "relative" ? safeNum(PlayState.currentTime) + payload.seconds : payload.seconds));
				break;
			}
		}
	})
);

// #endregion

// #region Custom Hotkeys

(async () => {
	if (!(await getTidalHifiSetting<boolean>("enableCustomHotkeys"))) return;

	const hotkeys = await getTidalHifiSetting<Record<string, string>>("hotkeys");
	if (!hotkeys) return;

	const matchesHotkey = (e: KeyboardEvent, hotkey: string): boolean => {
		const parts = hotkey.toLowerCase().split("+");
		const key = parts.pop()!;
		const needCtrl = parts.includes("control") || parts.includes("ctrl");
		const needAlt = parts.includes("alt");
		const needShift = parts.includes("shift");
		if (e.ctrlKey !== needCtrl || e.altKey !== needAlt || e.shiftKey !== needShift) return false;

		const keyMap: Record<string, string> = { up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright" };
		return e.key.toLowerCase() === (keyMap[key] ?? key);
	};

	const clickEl = (selector: string) => document.querySelector<HTMLElement>(selector)?.click();

	const actions: Record<string, () => void> = {
		toggleFavorite: () => clickEl('[data-test="footer-favorite-button"]'),
		logout: () => {
			if (confirm("Are you sure you want to log out?")) {
				localStorage.clear();
				sessionStorage.clear();
				window.location.reload();
			}
		},
		hardReload: () => window.location.reload(),
		toggleRepeat: cycleRepeatMode,
		shareTrackLink: () => {
			const url = lastInfo.url as string;
			if (url) {
				navigator.clipboard.writeText(url).then(() => {
					sendNotification("Link copied", url);
				});
			}
		},
		goBack: () => history.back(),
		goForward: () => history.forward(),
		openSettings1: () => __ipcRenderer.send("showSettings"),
		openSettings2: () => __ipcRenderer.send("showSettings"),
		deleteDisabled: () => {},
		volumeUp: () => redux.actions["playbackControls/INCREASE_VOLUME"](undefined as never),
		volumeDown: () => redux.actions["playbackControls/DECREASE_VOLUME"](undefined as never),
		expandNowPlaying: () => clickEl('[aria-label^="toggle now playing screen"]'),
		sidebarMusic: () => clickEl('[data-test="sidebar-music"]'),
		sidebarExplore: () => clickEl('[data-test="sidebar-explore"]'),
		sidebarFeed: () => clickEl('[data-test="sidebar-feed"]'),
		sidebarUpload: () => clickEl('[data-test="sidebar-uploads"]'),
		toggleSidebar: () => {
			const collapse = document.querySelector<HTMLElement>('[data-test="sidebar-collapse"]');
			if (collapse && !collapse.hasAttribute("disabled")) collapse.click();
			else document.querySelector<HTMLElement>('[data-test="sidebar-expand"]')?.click();
		},
		sidebarCollectionPlaylists: () => clickEl('[data-test="sidebar-collection-playlists"]'),
		sidebarCollectionAlbums: () => clickEl('[data-test="sidebar-collection-albums"]'),
		sidebarCollectionTracks: () => clickEl('[data-test="sidebar-collection-tracks"]'),
		sidebarCollectionVideos: () => clickEl('[data-test="sidebar-collection-videos"]'),
		sidebarCollectionArtists: () => clickEl('[data-test="sidebar-collection-artists"]'),
		sidebarCollectionMixes: () => clickEl('[data-test="sidebar-collection-mixes-and-radio"]'),
	};

	const handler = (e: KeyboardEvent) => {
		for (const [actionId, key] of Object.entries(hotkeys)) {
			if (key && matchesHotkey(e, key) && actions[actionId]) {
				e.preventDefault();
				actions[actionId]();
				return;
			}
		}
	};

	document.addEventListener("keydown", handler);
	unloads.add(() => document.removeEventListener("keydown", handler));
	linuxTrace.log("Custom hotkeys enabled");
})();

// #endregion

// #region Settings API

/** Open tidal-hifi Settings window */
export const showSettings = () => __ipcRenderer.send("showSettings");

/** Hide tidal-hifi Settings window */
export const hideSettings = () => __ipcRenderer.send("hideSettings");

// #endregion
