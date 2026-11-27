import type { MaybePromise } from "@inrixia/helpers";
import type { IArtistCredit } from "musicbrainz-api";

import { contentInstances } from "../caches";
import * as redux from "../redux";
import type { Artist } from "./Artist";

type ContentType = keyof redux.Content;
type ContentItem<K extends ContentType> = redux.Content[K][keyof redux.Content[K]];
type ContentClass<K extends ContentType> = {
	new (itemId: redux.ItemId, contentItem: ContentItem<K>, ...args: any[]): any;
};
export type TCoverRes = "1280" | "640" | "320" | "160" | "80";
export type TCoverType = "video" | "image";
export type TCoverOpts = {
	res?: TCoverRes;
	type?: TCoverType;
	fallback?: false;
};

export class ContentBase {
	/**
	 * Ensure instances of ContentClass's are properly cached and abstracts fetching from the store.
	 * Looks in the type's bounded cache, then its weak refs (an instance evicted but still held keeps its identity), then builds with `generator`.
	 */
	protected static async fromStore<K extends ContentType, C extends ContentClass<K>, I extends InstanceType<C>>(
		itemId: redux.ItemId,
		contentType: K,
		generator: (contentItem?: ContentItem<K>) => MaybePromise<I | undefined>,
	): Promise<I | undefined> {
		const { cache, weakRefs } = contentInstances(contentType);
		const key = String(itemId);
		const cached = cache.get(key);
		if (cached !== undefined) return cached as I;
		const held = weakRefs.get(key);
		if (held !== undefined) {
			cache.set(key, held).catch(ContentBase.keepFailed);
			return held as I;
		}

		const contentClass = await generator(this.getItemFromStore(contentType, itemId));
		if (contentClass === undefined) return;

		// Built while another call for the key was building: that one wins so the key has one instance
		const raced = weakRefs.get(key);
		if (raced !== undefined) return raced as I;
		weakRefs.set(key, contentClass);
		cache.set(key, contentClass).catch(ContentBase.keepFailed);
		return contentClass;
	}
	/** An instance the cache can't keep is still held by its weak ref, so the failure costs nothing */
	private static readonly keepFailed = () => {};

	/**
	 * Fetches a content item from redux.store.content
	 */
	public static getItemFromStore<K extends ContentType>(contentType: K, itemId: redux.ItemId): ContentItem<K> {
		const storeContent = redux.store.getState().content;
		return storeContent[contentType][itemId as keyof redux.Content[K]] as ContentItem<K>;
	}

	/**
	 * Replace typographic quotes (used by MusicBrainz) with plain ones (used by Tidal).
	 */
	public static normalizeQuotes(text: string): string {
		return text.replace(/[‘’‛]/g, "'").replace(/[“”„]/g, '"');
	}

	protected static formatTitle(tidalTitle?: string, tidalVersion?: string, brainzTitle?: string, brainzCredit?: IArtistCredit[]): string {
		brainzTitle = brainzTitle && ContentBase.normalizeQuotes(brainzTitle);

		let title = brainzTitle ?? tidalTitle;
		if (title === undefined) throw new Error("Title is undefined");

		// If the title has feat and its validated by musicBrainz then use the tidal title.
		if (tidalTitle?.includes("feat. ") && !brainzTitle?.includes("feat. ")) {
			const mbHasFeat = brainzCredit && brainzCredit.findIndex((credit) => credit.joinphrase === " feat. ") !== -1;
			if (mbHasFeat) title = tidalTitle;
		}

		// Dont use musicBrainz disambiguation as its not the same as the tidal version!
		if (tidalVersion && !ContentBase.normalizeQuotes(title).toLowerCase().includes(ContentBase.normalizeQuotes(tidalVersion).toLowerCase())) {
			title += ` (${tidalVersion})`;
		}

		return title;
	}

	public static getAlbumCoverUrl(album?: redux.Album | null, opts?: TCoverOpts) {
		if (!album) return;
		let type = opts?.type ?? "image";
		if (type === "video" && !album.videoCover && !(opts?.fallback === false)) type = "image";
		const uuid = type === "image" ? album.cover : album.videoCover;
		if (uuid) return ContentBase.formatCoverUrl(uuid, opts);
	}

	public static formatCoverUrl(uuid?: string, opts?: TCoverOpts) {
		if (!uuid) return;
		const type = opts?.type ?? "image";
		const res = opts?.res ?? "1280";
		const ext = type === "image" ? "jpg" : "mp4";
		return `https://resources.tidal.com/${type}s/${uuid.split("-").join("/")}/${res}x${res}.${ext}`;
	}

	public static async artistNames(artists?: Promise<Promise<Artist | undefined>[]> | Promise<Artist | undefined>[]): Promise<string[]> {
		const _artists = await artists;
		if (!_artists) return [];
		const artistNames = [];
		for await (const artist of _artists) {
			if (artist?.name) artistNames.push(artist?.name);
		}
		return artistNames;
	}
}
