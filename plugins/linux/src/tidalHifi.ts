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
	window.__ipcRenderer.invoke("__Luna.getTidalHifiSetting", key).catch(() => undefined);

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

const mapRepeat = (mode: string) =>
	mode === "REPEAT_ONE" ? "single" : mode === "REPEAT_ALL" ? "all" : "off";

const injectCSS = (css: string) => {
	const style = document.createElement("style");
	style.innerHTML = css;
	document.head.appendChild(style);
};

const cycleRepeatMode = () => {
	const modes = ["REPEAT_OFF", "REPEAT_ALL", "REPEAT_ONE"] as const;
	const i = modes.indexOf(PlayState.repeatMode as typeof modes[number]);
	PlayState.setRepeatMode(modes[(i + 1) % 3] as Parameters<typeof PlayState.setRepeatMode>[0]);
};

const sendNotification = (title: string, body: string, icon?: string) => {
	if (Notification.permission === "granted") {
		new Notification(title, { body, icon });
	} else if (Notification.permission !== "denied") {
		Notification.requestPermission().then((p) => p === "granted" && new Notification(title, { body, icon }));
	}
};

// #endregion

// #region CSS & Themes

(async () => {
	try {
		const theme = await getTidalHifiSetting<string>("theme");
		if (theme && theme !== "none") {
			const themeCSS = await window.__ipcRenderer.invoke("__Luna.getTidalHifiThemeCSS", theme).catch(() => undefined);
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

const sendUpdateInfo = (status: string) => {
	const currentSec = safeNum(PlayState.currentTime);
	window.__ipcRenderer.send("update-info", {
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
		const [title, artists, album, image] = await Promise.all([
			item.title(),
			item.artists().then((a) => Promise.all(a)),
			item.album(),
			item.coverUrl({ width: 640, height: 640 }),
		]);

		const artistStr = artists?.map((a) => a?.name).filter(Boolean).join(", ") || "Unknown";
		const durationSec = safeNum(item.duration);
		const currentSec = safeNum(PlayState.currentTime);

		lastInfo = {
			title: title ?? "Unknown",
			artists: artistStr,
			album: (await album?.title()) ?? "",
			url: item.url ?? "",
			image: image ?? "",
			icon: image ?? "",
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

		window.__ipcRenderer.send("update-info", lastInfo);
		linuxTrace.log("Sent update-info:", title);

		// Window title
		document.title = (await getTidalHifiSetting<boolean>("staticWindowTitle"))
			? "TIDAL Hi-Fi"
			: `${title ?? "Unknown"} - ${artistStr}`;

		// Skip artists
		if (await getTidalHifiSetting<boolean>("skipArtists")) {
			const skippedArtists = (await getTidalHifiSetting<string[]>("skippedArtists")) ?? [];
			const artistNames = artists?.map((a) => a?.name).filter(Boolean) as string[];
			if (artistNames.some((name) => skippedArtists.includes(name))) {
				linuxTrace.log("Skipping artist:", artistNames);
				PlayState.next();
				return;
			}
		}

		// Desktop notification
		if (await getTidalHifiSetting<boolean>("notifications")) {
			sendNotification(lastInfo.title as string, artistStr, image ?? undefined);
		}
	} catch (err) {
		linuxTrace.err.withContext("tidalHifi.onMediaTransition")(err);
	}
});

PlayState.onState(unloads, (state) => {
	if (!lastInfo.title) return;
	sendUpdateInfo(state === "PLAYING" ? "playing" : "paused");
});

const updateInterval = setInterval(() => {
	if (!lastInfo.title || !PlayState.playing) return;
	sendUpdateInfo("playing");
}, 5000);
unloads.add(() => clearInterval(updateInterval));

// #endregion

// #region Playback Controls (IPC)

unloads.add(
	window.__ipcRenderer.on("globalEvent", (action: string, payload?: unknown) => {
		linuxTrace.log("globalEvent:", action);
		switch (action) {
			case "play": PlayState.play(); break;
			case "pause": PlayState.pause(); break;
			case "playPause": PlayState.playing ? PlayState.pause() : PlayState.play(); break;
			case "next": PlayState.next(); break;
			case "previous": PlayState.previous(); break;
			case "toggleShuffle": PlayState.setShuffle(!PlayState.shuffle, true); break;
			case "toggleRepeat": cycleRepeatMode(); break;
			case "seek": if (typeof payload === "number") PlayState.seek(payload); break;
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
		openSettings1: () => window.__ipcRenderer.send("showSettings"),
		openSettings2: () => window.__ipcRenderer.send("showSettings"),
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
export const showSettings = () => window.__ipcRenderer.send("showSettings");

/** Hide tidal-hifi Settings window */
export const hideSettings = () => window.__ipcRenderer.send("hideSettings");

// #endregion
