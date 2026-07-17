import type { ItemId } from "neptune-types/tidal";
import type { MediaCollection } from "../MediaCollection";
import { MediaItem } from "./MediaItem";

import type * as redux from "../../redux";

export type MediaItemBase = { item: { id: redux.ItemId }; type: redux.ContentType };

export class MediaItems implements MediaCollection {
	private constructor(public readonly tMediaItems: MediaItemBase[]) {}

	public static fromIds(itemIds: ItemId[], type: redux.ContentType = "track") {
		return new this(itemIds.map((id) => ({ item: { id }, type })));
	}
	public static fromTMediaItems(tMediaItems: MediaItemBase[]) {
		return new this(tMediaItems);
	}

	public async title() {
		for await (const mediaItem of await this.mediaItems()) {
			return mediaItem.tidalItem.title;
		}
	}

	public async count() {
		return this.tMediaItems.length;
	}
	public async mediaItems() {
		return MediaItem.fromTMediaItems(this.tMediaItems);
	}
}
