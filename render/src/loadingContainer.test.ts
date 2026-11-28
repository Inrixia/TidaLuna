import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { splashFadeMs } from "./brand";
import { fadeOutLoadingContainer, getOrCreateLoadingContainer } from "./loadingContainer";

const splashUrl = `data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=`;

beforeEach(() => {
	document.getElementById("tidaluna-loading")?.remove();
	document.getElementById("tidaluna-splash-styles")?.remove();
	document.getElementById("wimp")?.remove();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("getOrCreateLoadingContainer", () => {
	test("shows the splash artwork sized to the window", () => {
		const { loadingContainer } = getOrCreateLoadingContainer(splashUrl);
		const art = loadingContainer.querySelector<HTMLImageElement>("#tidaluna-splash-image")!;
		expect(art.src).toBe(splashUrl);
		// Sizing lives in the stylesheet, because `min()` against the window is not something an inline style can be read back from
		expect(document.getElementById("tidaluna-splash-styles")!.textContent).toContain("min(92vw");
	});

	test("fades the artwork's own edges so it blends into the wash", () => {
		const { loadingContainer } = getOrCreateLoadingContainer(splashUrl);
		const art = loadingContainer.querySelector<HTMLImageElement>("#tidaluna-splash-image")!;
		expect(art.style.maskImage).toContain("linear-gradient");
		expect(art.style.maskComposite).toBe("intersect");
	});

	test("washes the bands with a blurred copy of the same artwork", () => {
		const { loadingContainer } = getOrCreateLoadingContainer(splashUrl);
		const blur = loadingContainer.querySelector<HTMLDivElement>("#tidaluna-splash-blur")!;
		expect(blur.style.backgroundImage).toBe(`url("${splashUrl}")`);
		expect(blur.style.backgroundSize).toBe("cover");
		expect(blur.style.filter).toContain("blur(");
	});

	test("keeps the artwork's own edge colour behind the wash", () => {
		const { loadingContainer } = getOrCreateLoadingContainer(splashUrl);
		expect(loadingContainer.querySelector<HTMLDivElement>("#tidaluna-splash")!.style.backgroundColor).toBe("#040a11");
	});

	test("darkens towards the window edges over the artwork so no boundary shows as a line", () => {
		const { loadingContainer } = getOrCreateLoadingContainer(splashUrl);
		const vignette = loadingContainer.querySelector<HTMLDivElement>("#tidaluna-splash-vignette")!;
		expect(vignette.style.backgroundImage).toContain("radial-gradient");
	});

	test("adds the splash stylesheet once, not per container", () => {
		getOrCreateLoadingContainer(splashUrl);
		getOrCreateLoadingContainer(splashUrl);
		const styles = document.querySelectorAll("#tidaluna-splash-styles");
		expect(styles).toHaveLength(1);
		expect(styles[0].textContent).toContain("lunaSplashDrift");
	});

	test("adds the drifting colour layers, positioned and animated by the stylesheet", () => {
		const { loadingContainer } = getOrCreateLoadingContainer(splashUrl);
		const auroras = [...loadingContainer.querySelectorAll<HTMLElement>("[class^='luna-splash-aurora']")];
		expect(auroras).toHaveLength(3);
		expect(auroras.map((n) => n.id)).toEqual(["luna-splash-aurora-0", "luna-splash-aurora-1", "luna-splash-aurora-2"]);
		// Nothing inline: sizing and animation live in the stylesheet, which is what keeps them compositor-only
		for (const aurora of auroras) expect(aurora.style.width).toBe("");
	});

	test("has no splash when no artwork is given", () => {
		const { loadingContainer } = getOrCreateLoadingContainer();
		expect(loadingContainer.querySelector("#tidaluna-splash")).toBeNull();
	});

	test("keeps a message container for progress and for the luna.js failure text", () => {
		const { messageContainer } = getOrCreateLoadingContainer(splashUrl);
		expect(messageContainer.id).toBe("tidaluna-loading-text");
		// Below the artwork and centred on it, where the old "Loading TidaLuna..." text used to sit
		expect(messageContainer.style.bottom).toBe("9%");
		expect(messageContainer.style.left).toBe("50%");
		expect(messageContainer.style.transform).toBe("translateX(-50%)");
	});

	test("never swallows a click meant for the client", () => {
		expect(getOrCreateLoadingContainer(splashUrl).loadingContainer.style.pointerEvents).toBe("none");
	});

	test("reuses the container instead of stacking another splash", () => {
		const first = getOrCreateLoadingContainer(splashUrl);
		const second = getOrCreateLoadingContainer(splashUrl);
		expect(second.loadingContainer).toBe(first.loadingContainer);
		expect(second.messageContainer).toBe(first.messageContainer);
		expect(document.querySelectorAll("#tidaluna-splash")).toHaveLength(1);
	});

	test("is appended to the body", () => {
		expect(document.body.contains(getOrCreateLoadingContainer(splashUrl).loadingContainer)).toBe(true);
	});

	test("stays above the page instead of dropping behind it mid-boot", () => {
		const wimp = document.createElement("div");
		wimp.id = "wimp";
		document.body.appendChild(wimp);
		// Flipping the splash behind the page while TIDAL painted underneath is what made it jump
		expect(getOrCreateLoadingContainer(splashUrl).loadingContainer.style.zIndex).toBe("3");
	});
});

describe("fadeOutLoadingContainer", () => {
	test("marks the splash as leaving, which the stylesheet turns into a fade", () => {
		const { loadingContainer } = getOrCreateLoadingContainer(splashUrl);

		fadeOutLoadingContainer(loadingContainer);

		expect(loadingContainer.dataset.fadingOut).toBe("true");
		expect(document.getElementById("tidaluna-splash-styles")!.textContent).toContain('#tidaluna-loading[data-fading-out="true"]');
	});

	test("takes it out of the page only once it has faded and TIDAL's own loader is gone", () => {
		vi.useFakeTimers();
		const { loadingContainer } = getOrCreateLoadingContainer(splashUrl);

		fadeOutLoadingContainer(loadingContainer);
		vi.advanceTimersByTime(splashFadeMs);
		// Still attached, but no longer animating, so nothing is being painted behind the client
		expect(document.getElementById("tidaluna-loading")).not.toBeNull();
		expect(loadingContainer.querySelector<HTMLElement>("#tidaluna-splash-image")!.style.animation).toBe("none");

		vi.advanceTimersByTime(splashFadeMs + 100);
		expect(document.getElementById("tidaluna-loading")).toBeNull();
	});

	test("waits for TIDAL's loader before tearing the splash down", async () => {
		vi.useFakeTimers();
		const loader = document.createElement("div");
		loader.id = "app-loader";
		document.body.appendChild(loader);
		const { loadingContainer } = getOrCreateLoadingContainer(splashUrl);

		fadeOutLoadingContainer(loadingContainer);
		await vi.advanceTimersByTimeAsync(splashFadeMs + 300);
		expect(document.getElementById("tidaluna-loading")).not.toBeNull();

		loader.remove();
		// The loader leaving is observed, so the callback lands on a microtask rather than on a tick
		await vi.advanceTimersByTimeAsync(500);
		expect(document.getElementById("tidaluna-loading")).toBeNull();
	});

	test("does not restart the fade when a slow boot resolves another module", () => {
		vi.useFakeTimers();
		const { loadingContainer } = getOrCreateLoadingContainer(splashUrl);

		fadeOutLoadingContainer(loadingContainer);
		vi.advanceTimersByTime(200);
		fadeOutLoadingContainer(loadingContainer);

		expect(loadingContainer.dataset.fadingOut).toBe("true");
		// One removal, still at the original time
		vi.advanceTimersByTime(splashFadeMs + 400);
		expect(document.getElementById("tidaluna-loading")).toBeNull();
	});
});
