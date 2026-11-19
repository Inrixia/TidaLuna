import type { LunaUnload, LunaUnloads, Tracer } from "@luna/core";

import { libTrace, unloads } from "../index.safe";

type Override = { imageIds: string[]; url: string };

// Matches urls like https://resources.tidal.com/images/aaaaaaaa/bbbb/cccc/dddd/eeeeeeeeeeee/640x640.jpg
const tidalImageUrl =
	/https?:\/\/resources\.tidal\.com\/images\/([0-9a-f]{8}\/[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{12})\/[^\s,"')]+/gi;

const coverAttributes = ["src", "srcset"];
const isCoverElement = (elem: Element) => elem instanceof HTMLImageElement || elem instanceof HTMLSourceElement;

const nativeSetAttribute = Element.prototype.setAttribute;
const nativeSetProperty = CSSStyleDeclaration.prototype.setProperty;
const mediaSessionMetadata = Object.getOwnPropertyDescriptor(MediaSession.prototype, "metadata")!;

/**
 * Show your own image wherever Tidal shows one of its images (album covers, playlist images, artist pictures etc).
 *
 * Tidal builds every image (headers, grids, track rows, the player bar, now playing) from a `resources.tidal.com/images/<id>/...` url.
 * While an override exists those urls are rewritten when they are set on `img`/`source` elements (`src`, `srcset`) or in inline styles
 * (eg. the blurred header background `--img: url(...)`), and in the `navigator.mediaSession` artwork used by the OS media controls.
 * Images already on screen are updated straight away and Tidal's own urls are put back when the override is removed.
 *
 * @example
 * const album = await Album.fromId(albumId);
 * ImageOverrides.add(unloads, album.tidalAlbum.cover, "https://example.com/cover.jpg");
 */
export class ImageOverrides {
	public static readonly trace: Tracer = libTrace.withSource(".ImageOverrides").trace;

	private static readonly overrides: Set<Override> = new Set();
	/** Tidal image id -> url to show instead */
	private static replacements: Map<string, string> = new Map();
	/** Values Tidal set before they were replaced, keyed by the element (src/srcset), its style declaration (css properties) or MediaMetadata */
	private static originals: WeakMap<object, Record<string, any>> = new WeakMap();
	private static patchedProps: [object, string, PropertyDescriptor][] = [];

	/**
	 * Show `url` instead of the Tidal images with the given ids until the returned function is called or `unloads` are run.
	 * @param imageIds Tidal image ids (uuids) eg. `tidalAlbum.cover`, `tidalPlaylist.squareImage`
	 * @param url Any url an `img` can show (http(s), data or blob url)
	 * @returns Removes the override
	 */
	public static add(unloads: LunaUnloads, imageIds: string | (string | null | undefined)[] | null | undefined, url: string): LunaUnload {
		const ids = (Array.isArray(imageIds) ? imageIds : [imageIds]).filter((id): id is string => typeof id === "string" && id.length > 0);
		const override: Override = { imageIds: ids.map((id) => id.toLowerCase()), url };
		this.overrides.add(override);
		this.update();
		const remove: LunaUnload = () => {
			unloads.delete(remove);
			if (!this.overrides.delete(override)) return;
			this.update();
		};
		remove.source = "ImageOverrides";
		unloads.add(remove);
		return remove;
	}

	/**
	 * Returns `value` with every Tidal image url that has an override replaced by the override's url
	 */
	public static replaceUrls(value: string): string {
		if (this.replacements.size === 0 || !value.includes("resources.tidal.com")) return value;
		return value.replace(tidalImageUrl, (url, idPath: string) => this.replacements.get(idPath.replaceAll("/", "-").toLowerCase()) ?? url);
	}

	private static update() {
		const replacements = new Map<string, string>();
		// Later overrides win
		for (const { imageIds, url } of this.overrides) for (const id of imageIds) replacements.set(id, url);
		this.replacements = replacements;

		if (replacements.size !== 0) this.patch();
		this.updateRendered();
		this.updateMediaSession();
		if (replacements.size === 0) this.unpatch();
	}

	/** Replaces the image urls in a value Tidal sets and remembers the original so it can be restored */
	private static rewrite(owner: object, name: string, value: string) {
		const replaced = this.replaceUrls(value);
		const ownerOriginals = this.originals.get(owner);
		if (replaced !== value) this.originals.set(owner, { ...ownerOriginals, [name]: value });
		else if (ownerOriginals?.[name] !== undefined) delete ownerOriginals[name];
		return replaced;
	}

	/** Applies the current overrides to the images already on screen */
	private static updateRendered() {
		for (const elem of document.querySelectorAll("img, source")) {
			for (const name of coverAttributes) {
				const current = elem.getAttribute(name);
				if (current === null) continue;
				const replaced = this.rewrite(elem, name, this.originals.get(elem)?.[name] ?? current);
				if (replaced !== current) nativeSetAttribute.call(elem, name, replaced);
			}
		}
		for (const elem of document.querySelectorAll<HTMLElement>("[style]")) {
			const style = elem.style;
			const names = new Set(Object.keys(this.originals.get(style) ?? {}));
			for (let i = 0; i < style.length; i++) if (style.getPropertyValue(style[i]).includes("url(")) names.add(style[i]);
			for (const name of names) {
				const current = style.getPropertyValue(name);
				const replaced = this.rewrite(style, name, this.originals.get(style)?.[name] ?? current);
				if (replaced !== current) nativeSetProperty.call(style, name, replaced, style.getPropertyPriority(name));
			}
		}
	}

	/** Setting the metadata again runs it through the patched setter */
	private static updateMediaSession() {
		const metadata = navigator.mediaSession.metadata;
		if (metadata !== null) navigator.mediaSession.metadata = metadata;
	}

	private static patch() {
		if (this.patchedProps.length !== 0) return;
		const self = this;
		Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
			if (isCoverElement(this) && coverAttributes.includes(name.toLowerCase())) value = self.rewrite(this, name.toLowerCase(), String(value));
			return nativeSetAttribute.call(this, name, value);
		};
		CSSStyleDeclaration.prototype.setProperty = function (this: CSSStyleDeclaration, name: string, value: string | null, priority?: string) {
			if (typeof value === "string" && value.includes("url(")) value = self.rewrite(this, name, value);
			return nativeSetProperty.call(this, name, value, priority);
		};
		Object.defineProperty(MediaSession.prototype, "metadata", {
			...mediaSessionMetadata,
			set(this: MediaSession, metadata: MediaMetadata | null) {
				if (metadata !== null) {
					// Use the artwork Tidal set unless Tidal changed it since it was replaced
					const previous = self.originals.get(metadata);
					const unchanged = previous !== undefined && metadata.artwork.every((image, i) => image.src === previous.replaced[i]?.src);
					const artwork: readonly MediaImage[] = unchanged ? previous.artwork : metadata.artwork;
					const replaced = artwork.map((image) => ({ ...image, src: self.replaceUrls(image.src) }));
					self.originals.set(metadata, { artwork, replaced });
					metadata.artwork = replaced;
				}
				mediaSessionMetadata.set!.call(this, metadata);
			},
		});
		for (const proto of [HTMLImageElement.prototype, HTMLSourceElement.prototype]) {
			for (const name of coverAttributes) {
				const descriptor = Object.getOwnPropertyDescriptor(proto, name)!;
				this.patchedProps.push([proto, name, descriptor]);
				Object.defineProperty(proto, name, {
					...descriptor,
					set(this: Element, value: string) {
						descriptor.set!.call(this, self.rewrite(this, name, String(value)));
					},
				});
			}
		}
	}

	private static unpatch() {
		if (this.patchedProps.length === 0) return;
		Element.prototype.setAttribute = nativeSetAttribute;
		CSSStyleDeclaration.prototype.setProperty = nativeSetProperty;
		Object.defineProperty(MediaSession.prototype, "metadata", mediaSessionMetadata);
		for (const [proto, name, descriptor] of this.patchedProps.splice(0)) Object.defineProperty(proto, name, descriptor);
		this.originals = new WeakMap();
	}

	static {
		// Put Tidal's images back if the lib unloads before the plugins that added overrides
		unloads.add(() => {
			this.overrides.clear();
			this.update();
		});
	}
}
