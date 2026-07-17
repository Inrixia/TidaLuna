import type { MaybePromise } from "@inrixia/helpers";
import type { IArtistCredit } from "musicbrainz-api";

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
	private static readonly _instances: Record<string, Record<redux.ItemId, ContentClass<ContentType>>> = {};

	/**
	 * Ensure instances of ContentClass's are properly cached and abstracts fetching from the store.
	 */
	protected static async fromStore<K extends ContentType, C extends ContentClass<K>, I extends InstanceType<C>>(
		itemId: redux.ItemId,
		contentType: K,
		generator: (contentItem?: ContentItem<K>) => MaybePromise<I | undefined>,
	): Promise<I | undefined> {
		if (this._instances[contentType]?.[itemId] !== undefined) return this._instances[contentType][itemId] as I;

		const contentClass = await generator(this.getItemFromStore(contentType, itemId));
		if (contentClass === undefined) return;

		this._instances[contentType] ??= {};
		return (this._instances[contentType][itemId] = contentClass);
	}

	/**
	 * Fetches a content item from redux.store.content
	 */
	public static getItemFromStore<K extends ContentType>(contentType: K, itemId: redux.ItemId): ContentItem<K> {
		const storeContent = redux.store.getState().content;
		return storeContent[contentType][itemId as keyof redux.Content[K]] as ContentItem<K>;
	}

	protected static formatTitle(tidalTitle?: string, tidalVersion?: string, brainzTitle?: string, brainzCredit?: IArtistCredit[]): string {
		brainzTitle = brainzTitle?.replaceAll("’", "'");

		let title = brainzTitle ?? tidalTitle;
		if (title === undefined) throw new Error("Title is undefined");

		// If the title has feat and its validated by musicBrainz then use the tidal title.
		if (tidalTitle?.includes("feat. ") && !brainzTitle?.includes("feat. ")) {
			const mbHasFeat = brainzCredit && brainzCredit.findIndex((credit) => credit.joinphrase === " feat. ") !== -1;
			if (mbHasFeat) title = tidalTitle;
		}

		// Dont use musicBrainz disambiguation as its not the same as the tidal version!
		if (tidalVersion && !title.toLowerCase().includes(tidalVersion.toLowerCase())) title += ` (${tidalVersion})`;

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
