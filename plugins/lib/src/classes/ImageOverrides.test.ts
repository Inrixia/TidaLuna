import { unloadSet, type LunaUnload } from "@luna/core";
import { afterEach, describe, expect, test, vi } from "vitest";

// happy-dom has no Media Session API, and ImageOverrides reads `MediaSession.prototype.metadata` when it is imported.
// It has to be an accessor on the prototype: that descriptor is what ImageOverrides saves and restores, so a plain
// class field would leave it nothing to put back.
vi.hoisted(() => {
	class TestMediaSession {
		#metadata: unknown = null;
		public get metadata() {
			return this.#metadata;
		}
		public set metadata(value: unknown) {
			this.#metadata = value;
		}
		public playbackState = "none";
		public setActionHandler() {}
		public setPositionState() {}
	}
	(globalThis as any).MediaSession = TestMediaSession;
	Object.defineProperty(navigator, "mediaSession", { value: new TestMediaSession(), configurable: true });
});

import { ImageOverrides } from "./ImageOverrides";

const overrideUrl = "https://example.com/luna-cover.jpg";
/** A TIDAL image id (uuid) and the url TIDAL builds from it, both as `ImageOverrides` matches them */
const imageId = (n: number) => `${n.toString(16).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`;
const tidalUrl = (id: string, res = "640") => `https://resources.tidal.com/images/${id.split("-").join("/")}/${res}x${res}.jpg`;

const unloads = new Set<LunaUnload>();
afterEach(async () => {
	await unloadSet(unloads);
	(navigator.mediaSession as any).metadata = null;
	document.body.innerHTML = "";
});

describe("replaceUrls", () => {
	test("leaves urls alone while no override exists", () => {
		const id = imageId(1);

		expect(ImageOverrides.replaceUrls(tidalUrl(id))).toBe(tidalUrl(id));
		expect(ImageOverrides.replaceUrls("https://example.com/other.jpg")).toBe("https://example.com/other.jpg");
	});

	test("shows the override url for the image id, at any resolution", () => {
		const id = imageId(2);

		ImageOverrides.add(unloads, id, overrideUrl);

		expect(ImageOverrides.replaceUrls(tidalUrl(id))).toBe(overrideUrl);
		expect(ImageOverrides.replaceUrls(tidalUrl(id, "320"))).toBe(overrideUrl);
		expect(ImageOverrides.replaceUrls(`background: url(${tidalUrl(id)})`)).toBe(`background: url(${overrideUrl})`);
		// Other images are untouched
		expect(ImageOverrides.replaceUrls(tidalUrl(imageId(3)))).toBe(tidalUrl(imageId(3)));
	});

	test("matches the image id whatever its case", () => {
		const id = imageId(4);

		ImageOverrides.add(unloads, id.toUpperCase(), overrideUrl);

		expect(ImageOverrides.replaceUrls(tidalUrl(id))).toBe(overrideUrl);
	});

	test("takes several image ids and skips the missing ones", () => {
		const first = imageId(5);
		const second = imageId(6);

		ImageOverrides.add(unloads, [first, undefined, null, "", second], overrideUrl);

		expect(ImageOverrides.replaceUrls(tidalUrl(first))).toBe(overrideUrl);
		expect(ImageOverrides.replaceUrls(tidalUrl(second))).toBe(overrideUrl);
		expect(ImageOverrides.replaceUrls(tidalUrl(imageId(7)))).toBe(tidalUrl(imageId(7)));
	});

	test("the last override for an id wins", () => {
		const id = imageId(8);

		ImageOverrides.add(unloads, id, "https://example.com/first.jpg");
		ImageOverrides.add(unloads, id, "https://example.com/second.jpg");

		expect(ImageOverrides.replaceUrls(tidalUrl(id))).toBe("https://example.com/second.jpg");
	});

	test("puts TIDAL's url back when the override is removed", async () => {
		const id = imageId(9);
		const remove = ImageOverrides.add(unloads, id, overrideUrl);

		await remove();

		expect(ImageOverrides.replaceUrls(tidalUrl(id))).toBe(tidalUrl(id));
		// Removing it twice is harmless
		await remove();
		expect(ImageOverrides.replaceUrls(tidalUrl(id))).toBe(tidalUrl(id));
	});

	test("removes the override when its unloads are run", async () => {
		const id = imageId(10);
		ImageOverrides.add(unloads, id, overrideUrl);

		await unloadSet(unloads);

		expect(ImageOverrides.replaceUrls(tidalUrl(id))).toBe(tidalUrl(id));
	});

	test("keeps the other overrides when one is removed", async () => {
		const first = imageId(11);
		const second = imageId(12);
		const removeFirst = ImageOverrides.add(unloads, first, overrideUrl);
		ImageOverrides.add(unloads, second, "https://example.com/other-cover.jpg");
		const img = document.createElement("img");
		document.body.append(img);

		await removeFirst();

		expect(ImageOverrides.replaceUrls(tidalUrl(first))).toBe(tidalUrl(first));
		expect(ImageOverrides.replaceUrls(tidalUrl(second))).toBe("https://example.com/other-cover.jpg");
		// Still patched, so images set now are rewritten too
		img.src = tidalUrl(second);
		expect(img.getAttribute("src")).toBe("https://example.com/other-cover.jpg");
	});
});

describe("rendered images", () => {
	test("updates an image already on screen and puts TIDAL's url back", async () => {
		const id = imageId(13);
		const img = document.createElement("img");
		img.src = tidalUrl(id);
		document.body.append(img);

		const remove = ImageOverrides.add(unloads, id, overrideUrl);
		expect(img.getAttribute("src")).toBe(overrideUrl);

		await remove();
		expect(img.getAttribute("src")).toBe(tidalUrl(id));
	});

	test("rewrites src and srcset set on the element and restores them", async () => {
		const id = imageId(14);
		const img = document.createElement("img");
		const source = document.createElement("source");
		document.body.append(img, source);

		const remove = ImageOverrides.add(unloads, id, overrideUrl);

		img.setAttribute("src", tidalUrl(id));
		img.setAttribute("srcset", `${tidalUrl(id)} 1x`);
		source.setAttribute("srcset", `${tidalUrl(id)} 2x`);
		expect(img.getAttribute("src")).toBe(overrideUrl);
		expect(img.getAttribute("srcset")).toBe(`${overrideUrl} 1x`);
		expect(source.getAttribute("srcset")).toBe(`${overrideUrl} 2x`);

		await remove();
		expect(img.getAttribute("src")).toBe(tidalUrl(id));
		expect(img.getAttribute("srcset")).toBe(`${tidalUrl(id)} 1x`);
		expect(source.getAttribute("srcset")).toBe(`${tidalUrl(id)} 2x`);
	});

	test("rewrites src and srcset set through the element's properties", async () => {
		const id = imageId(17);
		const img = document.createElement("img");
		const source = document.createElement("source");
		document.body.append(img, source);

		const remove = ImageOverrides.add(unloads, id, overrideUrl);
		img.src = tidalUrl(id);
		source.srcset = `${tidalUrl(id)} 2x`;

		expect(img.getAttribute("src")).toBe(overrideUrl);
		expect(source.getAttribute("srcset")).toBe(`${overrideUrl} 2x`);
		await remove();
	});

	test("rewrites image urls in inline styles and restores them", async () => {
		const id = imageId(15);
		const header = document.createElement("div");
		header.style.setProperty("--img", `url("${tidalUrl(id)}")`);
		document.body.append(header);

		const remove = ImageOverrides.add(unloads, id, overrideUrl);
		expect(header.style.getPropertyValue("--img")).toBe(`url("${overrideUrl}")`);

		await remove();
		expect(header.style.getPropertyValue("--img")).toBe(`url("${tidalUrl(id)}")`);
	});
});

describe("media session", () => {
	test("rewrites the artwork and puts TIDAL's back", async () => {
		const id = imageId(16);
		const remove = ImageOverrides.add(unloads, id, overrideUrl);

		(navigator.mediaSession as any).metadata = { artwork: [{ src: tidalUrl(id), sizes: "640x640", type: "image/jpeg" }] };
		expect((navigator.mediaSession as any).metadata.artwork[0].src).toBe(overrideUrl);

		await remove();
		expect((navigator.mediaSession as any).metadata.artwork[0].src).toBe(tidalUrl(id));
	});
});
