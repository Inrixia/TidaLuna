import { describe, expect, test } from "vitest";

import {
	splashArtFadeStyles,
	splashBackdropStyles,
	splashBlurStyles,
	splashFadeMs,
	splashStylesCss,
	splashVignetteStyles,
	svgDataUrl,
} from "./brand";

describe("svgDataUrl", () => {
	test("wraps base64 in an svg data uri", () => {
		expect(svgDataUrl("PHN2Zz48L3N2Zz4=")).toBe("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=");
	});

	test("keeps the svg mime type so a browser renders it as an image", () => {
		expect(svgDataUrl("abc")).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/);
	});
});

describe("splashBackdropStyles", () => {
	test("takes its colour from the artwork's own edge", () => {
		expect(splashBackdropStyles().backgroundColor).toBe("#040a11");
	});

	test("adds a wash so a letterboxed band is not flat", () => {
		expect(splashBackdropStyles().backgroundImage).toContain("radial-gradient");
	});
});

describe("splashBlurStyles", () => {
	test("covers the whole window with a blurred copy of the artwork", () => {
		const styles = splashBlurStyles("data:image/svg+xml;base64,abc");
		expect(styles.backgroundImage).toBe(`url("data:image/svg+xml;base64,abc")`);
		expect(styles.backgroundSize).toBe("cover");
		expect(styles.filter).toContain("blur(");
	});
});

describe("splashArtFadeStyles", () => {
	test("fades the artwork's own edges rather than ending on a line", () => {
		expect(splashArtFadeStyles().maskImage).toContain("linear-gradient");
	});

	test("intersects a horizontal and a vertical fade, because the artwork is 16:9 and the window is not", () => {
		expect(splashArtFadeStyles().maskComposite).toBe("intersect");
	});
});

describe("splashVignetteStyles", () => {
	test("is clear in the middle so the wordmark is untouched", () => {
		expect(splashVignetteStyles().backgroundImage).toContain("rgba(4, 10, 17, 0)");
	});

	test("reaches the artwork's edge colour at the window edge", () => {
		expect(splashVignetteStyles().backgroundImage).toContain("#040a11 100%");
	});
});

/** The bodies of every `@keyframes` block in the stylesheet, matched by brace depth so nested blocks are not truncated */
const keyframeBlocks = (css: string) => {
	const blocks: string[] = [];
	let index = css.indexOf("@keyframes");
	while (index !== -1) {
		let depth = 0;
		let end = index;
		for (let i = css.indexOf("{", index); i < css.length; i++) {
			if (css[i] === "{") depth++;
			else if (css[i] === "}" && --depth === 0) {
				end = i;
				break;
			}
		}
		blocks.push(css.slice(index, end + 1));
		index = css.indexOf("@keyframes", end);
	}
	return blocks;
};

describe("splashStylesCss", () => {
	test("fits the artwork to the window from its own 16:9 ratio, with a margin for the faded edges", () => {
		const css = splashStylesCss();
		expect(css).toContain("width: min(92vw, 156.4vh)");
		expect(css).toContain("height: auto");
	});

	test("moves the wash and breathes the artwork so the splash is not a still image", () => {
		const css = splashStylesCss();
		expect(css).toContain("lunaSplashDrift");
		expect(css).toContain("lunaSplashBreathe");
	});

	test("drifts three blobs of colour so the splash is not one flat wash", () => {
		const css = splashStylesCss();
		for (const animation of ["lunaAuroraCyan", "lunaAuroraTeal", "lunaAuroraIndigo"]) expect(css).toContain(animation);
	});

	test("every keyframe animates transforms only, because animating a filter repaints the layer every frame", () => {
		const blocks = keyframeBlocks(splashStylesCss());
		expect(blocks.length).toBeGreaterThanOrEqual(5);
		for (const block of blocks) {
			expect(block).toContain("transform:");
			expect(block).not.toContain("filter:");
			expect(block).not.toContain("hue-rotate");
		}
	});

	test("turns the animation off for anyone who asked for reduced motion", () => {
		expect(splashStylesCss()).toContain("@media (prefers-reduced-motion: reduce)");
	});
});

describe("splashFade", () => {
	test("is slow enough to read as a handover, not a flicker", () => {
		expect(splashFadeMs).toBeGreaterThanOrEqual(1000);
	});

	test("is a transition declared on the container before it starts leaving", () => {
		const css = splashStylesCss();
		expect(css).toContain("#tidaluna-loading {");
		expect(css).toContain(`transition: opacity ${splashFadeMs}ms`);
		expect(css).toContain('#tidaluna-loading[data-fading-out="true"]');
		expect(css).toContain("opacity: 0");
	});

	test("shortens the handover for reduced motion instead of swelling it", () => {
		expect(splashStylesCss()).toContain("transition-duration: 200ms");
	});
});
