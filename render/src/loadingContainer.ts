import { splashArtFadeStyles, splashBackdropStyles, splashBlurStyles, splashFadeMs, splashStylesCss, splashVignetteStyles } from "./brand";

const containerStyles: Partial<CSSStyleDeclaration> = {
	position: "absolute",
	// Stays above the page for its whole life: it is pointer-transparent, and flipping it behind the page mid-boot is what
	// made the splash jump while TIDAL was painting underneath it
	zIndex: "3",
	top: "0",
	left: "0",
	width: "100vw",
	height: "100vh",
	display: "flex",
	flexDirection: "column",
	alignItems: "center",
	justifyContent: "center",
	textAlign: "center",
	opacity: "1",
	overflow: "hidden",
	// The splash must never swallow a click meant for the client
	pointerEvents: "none",
};

const layerStyles: Partial<CSSStyleDeclaration> = {
	position: "absolute",
	top: "0",
	left: "0",
	width: "100%",
	height: "100%",
	zIndex: "-1",
};

const messageStyles: Partial<CSSStyleDeclaration> = {
	position: "absolute",
	bottom: "9%",
	left: "50%",
	transform: "translateX(-50%)",
	maxWidth: "60%",
	maxHeight: "22%",
	fontSize: "11px",
	lineHeight: "1.5",
	textAlign: "center",
	color: "rgba(255, 255, 255, 0.45)",
	overflow: "hidden",
};

/** Sizing and the drift/breathe animations, added once per page */
const ensureSplashStyles = () => {
	if (document.getElementById("tidaluna-splash-styles") !== null) return;
	const style = document.createElement("style");
	style.id = "tidaluna-splash-styles";
	style.textContent = splashStylesCss();
	(document.head ?? document.documentElement).appendChild(style);
};

/**
 * Four layers: the artwork letterboxed and faded at its own edges, a blurred cover-scaled copy of the same artwork
 * filling what it leaves, the artwork's own edge colour behind both, and a vignette over the top that darkens towards
 * the window edges so no boundary of the artwork can show as a line.
 */
const createSplash = (splashUrl: string) => {
	ensureSplashStyles();

	const splash = document.createElement("div");
	splash.id = "tidaluna-splash";
	Object.assign(splash.style, layerStyles, splashBackdropStyles());

	const blur = document.createElement("div");
	blur.id = "tidaluna-splash-blur";
	Object.assign(blur.style, layerStyles, splashBlurStyles(splashUrl));

	const artBox = document.createElement("div");
	artBox.id = "tidaluna-splash-art";
	Object.assign(artBox.style, layerStyles, { display: "flex", alignItems: "center", justifyContent: "center" });

	// An element sized to the artwork rather than a background on the window, so the fade lands on the artwork's edges
	const art = document.createElement("img");
	art.id = "tidaluna-splash-image";
	art.alt = "";
	art.src = splashUrl;
	Object.assign(art.style, splashArtFadeStyles());
	artBox.appendChild(art);

	// Drifting colour over the artwork, under the vignette so the window edges still darken over it. Position, size and
	// animation come from the stylesheet, so the blobs stay compositor-only.
	const auroras = [0, 1, 2].map((index) => {
		const aurora = document.createElement("div");
		aurora.id = `luna-splash-aurora-${index}`;
		aurora.className = "luna-splash-aurora";
		return aurora;
	});

	const vignette = document.createElement("div");
	vignette.id = "tidaluna-splash-vignette";
	Object.assign(vignette.style, layerStyles, splashVignetteStyles());

	splash.append(blur, artBox, ...auroras, vignette);
	return splash;
};

/** The container native/preload.ts writes boot progress and failures into */
const createMessageContainer = (parent: HTMLElement): HTMLDivElement => {
	const message = document.createElement("div");
	message.id = "tidaluna-loading-text";
	Object.assign(message.style, messageStyles);
	parent.appendChild(message);
	return message;
};

/**
 * The splash shows `splashUrl` filling the window for as long as Luna is booting TIDAL, and keeps a message container
 * for progress and for the failure message native/preload.ts writes into it.
 */
export const getOrCreateLoadingContainer = (splashUrl?: string) => {
	let loadingContainer = document.getElementById("tidaluna-loading") as HTMLDivElement | null;
	let messageContainer: HTMLDivElement;

	if (!loadingContainer) {
		loadingContainer = document.createElement("div");
		loadingContainer.id = "tidaluna-loading";
		Object.assign(loadingContainer.style, containerStyles);

		if (splashUrl !== undefined) loadingContainer.appendChild(createSplash(splashUrl));

		messageContainer = createMessageContainer(loadingContainer);

		// Prefer body, fallback to documentElement for early loading (tidal-hifi)
		if (document.body) {
			document.body.appendChild(loadingContainer);
		} else {
			// Held in a const so the observer below narrows it: the let is reassigned above, and a closure cannot trust it
			const container = loadingContainer;
			document.documentElement.appendChild(container);
			// Move to body once available
			const observer = new MutationObserver(() => {
				if (document.body) {
					observer.disconnect();
					document.body.appendChild(container);
				}
			});
			observer.observe(document.documentElement, { childList: true });
		}
	} else {
		// A container that outlived its message node still needs one: native writes boot failures into it
		messageContainer = loadingContainer.querySelector<HTMLDivElement>("#tidaluna-loading-text") ?? createMessageContainer(loadingContainer);
	}

	return { loadingContainer, messageContainer };
};

/**
 * Hands the window over to the client: the splash fades, blurs and swells a little, then leaves the DOM. Calling it
 * again while it is already fading does nothing, so a boot that loads modules slowly cannot restart the fade.
 */
/** Runs `cb` on a quiet frame, where removing a full-window layer does not land on top of a paint the client is doing. */
const requestIdle = (cb: () => void) => {
	if (window.requestIdleCallback !== undefined) window.requestIdleCallback(cb, { timeout: splashFadeMs });
	else setTimeout(cb, 0);
};

/**
 * TIDAL's own loader sits behind the splash. Tearing the splash down while that loader is still painted is what flashes for
 * a split second once the fade ends, so wait for the node to leave the page, giving up after a couple of seconds.
 */
const whenTidalLoaderGone = (cb: () => void, timeoutMs = 2000) => {
	const loader = document.getElementById("app-loader");
	if (loader === null) return cb();
	// Watching for the removal rather than asking on a timer: the loader leaving is the event being waited for
	const observer = new MutationObserver(() => {
		if (loader.isConnected) return;
		stop();
		cb();
	});
	const cap = setTimeout(() => {
		stop();
		cb();
	}, timeoutMs);
	const stop = () => {
		observer.disconnect();
		clearTimeout(cap);
	};
	observer.observe(loader.parentElement ?? document.documentElement, { childList: true });
};

export const fadeOutLoadingContainer = (loadingContainer: HTMLElement) => {
	if (loadingContainer.dataset.fadingOut === "true") return;
	// The transition is already on the element from the splash stylesheet, so setting this animates rather than cuts
	loadingContainer.dataset.fadingOut = "true";
	setTimeout(() => {
		// Stop the drift: it keeps the compositor busy on a layer nobody can see any more
		for (const layer of loadingContainer.querySelectorAll<HTMLElement>("*")) layer.style.animation = "none";
		// One teardown, not two: hiding it first and removing it later repaints the whole window twice, which reads as a flash
		whenTidalLoaderGone(() => requestIdle(() => loadingContainer.remove()));
	}, splashFadeMs);
};
