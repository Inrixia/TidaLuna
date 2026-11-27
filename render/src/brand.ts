/** `file://` imports are inlined as base64 by the build's fileUrl plugin; this turns one back into a usable URL. */
export const svgDataUrl = (base64: string) => `data:image/svg+xml;base64,${base64}`;

/** Corner colour of the splash artwork. */
const splashBackdrop = "#040a11";

/** How long the splash takes to give way to the client once TIDAL has mounted. */
export const splashFadeMs = 1400;

/** Backdrop: the artwork's own edge colours, so a band is never flat black. */
export const splashBackdropStyles = (): Partial<CSSStyleDeclaration> => ({
	backgroundColor: splashBackdrop,
	backgroundImage: `radial-gradient(circle at 55% 8%, #0c222c 0%, ${splashBackdrop} 60%)`,
});

/**
 * A blurred, cover-scaled copy of the artwork. It fills the space either side of the letterboxed artwork with its own
 * colours, so the artwork's edge meets a wash instead of a straight cut. Its size is set by the motion keyframes.
 */
export const splashBlurStyles = (url: string): Partial<CSSStyleDeclaration> => ({
	backgroundImage: `url("${url}")`,
	backgroundPosition: "center",
	backgroundRepeat: "no-repeat",
	backgroundSize: "cover",
	filter: "blur(64px) brightness(0.6)",
	willChange: "transform, filter",
});

/**
 * Fade for the artwork element. Sizing lives in `splashStylesCss` so it can use `min()` against the window, which an
 * inline style could too but a test could not read. The fade follows the artwork rather than the window, which a
 * full-window background could not do.
 */
export const splashArtFadeStyles = (): Partial<CSSStyleDeclaration> => ({
	willChange: "transform",
	maskImage:
		"linear-gradient(to right, transparent 0%, #000 14%, #000 86%, transparent 100%), linear-gradient(to bottom, transparent 0%, #000 16%, #000 84%, transparent 100%)",
	maskComposite: "intersect",
});

/**
 * Painted over everything: keeps the middle of the artwork clear and darkens towards the window edges to the artwork's
 * own edge colour, so no boundary can show as a line.
 */
export const splashVignetteStyles = (): Partial<CSSStyleDeclaration> => ({
	backgroundImage: `radial-gradient(ellipse 78% 68% at 50% 46%, rgba(4, 10, 17, 0) 40%, rgba(4, 10, 17, 0.92) 82%, ${splashBackdrop} 100%)`,
});

/**
 * Sizing and movement for the splash. The artwork keeps its own 16:9 ratio and is fitted to the window with a margin for
 * its faded edges, so it grows on a big screen and shrinks on a small one instead of being stretched either way.
 *
 * The movement is a transform only: animating `filter` on a full-window 64px blur repaints the whole splash every frame,
 * which is what made it flicker while TIDAL was still booting. All of it is off for anyone who asked for reduced motion.
 */
export const splashStylesCss = (): string => `
#tidaluna-splash-image {
	/* 16:9 artwork fitted inside the window: 92% of its width, or as wide as 88% of its height allows */
	width: min(92vw, 156.4vh);
	height: auto;
	animation: lunaSplashBreathe 13s ease-in-out infinite alternate;
}
#tidaluna-splash-blur {
	animation: lunaSplashDrift 44s ease-in-out infinite alternate;
}
@keyframes lunaSplashDrift {
	from { transform: scale(1.3) translate3d(0, 0, 0); }
	to { transform: scale(1.42) translate3d(-1.4%, 1.2%, 0); }
}
@keyframes lunaSplashBreathe {
	from { transform: scale(1); }
	to { transform: scale(1.014); }
}
@media (prefers-reduced-motion: reduce) {
	#tidaluna-splash-blur, #tidaluna-splash-image { animation: none; }
	#tidaluna-loading { transition-duration: 200ms; }
	[class^="luna-splash-aurora"] { animation: none; opacity: 0.28; }
}
/*
 * Moving colour. Three blurred gradient blobs drift across each other at different speeds, which reads as the splash
 * breathing colour rather than a still poster. The blur is static and only the transform animates, so the compositor can
 * move them without repainting anything; that is the same reason the artwork's own movement is transform-only.
 */
[class^="luna-splash-aurora"] {
	position: absolute;
	border-radius: 50%;
	pointer-events: none;
	filter: blur(80px);
	opacity: 0.3;
	will-change: transform;
}
/* Parked on the window edges rather than in the middle, so the wordmark keeps the dark background it was drawn on */
#luna-splash-aurora-0 {
	top: -18vmax;
	left: -14vmax;
	width: 54vmax;
	height: 54vmax;
	background: radial-gradient(circle, rgba(49, 216, 255, 0.38), rgba(49, 216, 255, 0) 65%);
	animation: lunaAuroraCyan 10s ease-in-out infinite alternate;
}
#luna-splash-aurora-1 {
	bottom: -20vmax;
	right: -16vmax;
	width: 50vmax;
	height: 50vmax;
	background: radial-gradient(circle, rgba(0, 220, 232, 0.34), rgba(0, 220, 232, 0) 65%);
	animation: lunaAuroraTeal 13s ease-in-out infinite alternate;
}
#luna-splash-aurora-2 {
	top: -10vmax;
	right: -18vmax;
	width: 44vmax;
	height: 44vmax;
	background: radial-gradient(circle, rgba(96, 122, 255, 0.3), rgba(96, 122, 255, 0) 68%);
	animation: lunaAuroraIndigo 16s ease-in-out infinite alternate;
}
@keyframes lunaAuroraCyan {
	from { transform: translate3d(-8vw, -5vh, 0) scale(0.85); }
	to { transform: translate3d(22vw, 16vh, 0) scale(1.3); }
}
@keyframes lunaAuroraTeal {
	from { transform: translate3d(14vw, 8vh, 0) scale(1.25); }
	to { transform: translate3d(-20vw, -14vh, 0) scale(0.8); }
}
@keyframes lunaAuroraIndigo {
	from { transform: translate3d(12vw, -8vh, 0) scale(0.85); }
	to { transform: translate3d(-16vw, 18vh, 0) scale(1.35); }
}
/*
 * The handover. The transition is declared here, on the container itself, rather than being set by the fade code: a
 * transition set in the same style write as the value it should animate is applied after the change and does not run.
 */
#tidaluna-loading {
	transition: opacity ${splashFadeMs}ms ease-in-out, transform ${splashFadeMs}ms ease-out;
	transform-origin: center;
}
#tidaluna-loading[data-fading-out="true"] {
	opacity: 0;
	transform: scale(1.02);
	pointer-events: none;
}
`;

/* How the splash leaves is in `splashStylesCss`: a CSS animation cannot be lost to the order a transition and the value
 * it should animate were set in, which is what a JS fade kept running into. */
