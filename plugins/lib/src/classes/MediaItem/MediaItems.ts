import type { ItemId } from "neptune-types/tidal";
import { trackTableProps, trackTableRows } from "../../helpers/trackTable";
import type { MediaCollection } from "../MediaCollection";
import { MediaItem } from "./MediaItem";

import * as redux from "../../redux";

export type MediaItemBase = { item: { id: redux.ItemId }; type: redux.ContentType };

export class MediaItems implements MediaCollection {
	private constructor(public readonly tMediaItems: MediaItemBase[]) {}

	public static fromIds(itemIds: ItemId[], type: redux.ContentType = "track") {
		return new this(itemIds.map((id) => ({ item: { id }, type })));
	}
	public static fromTMediaItems(tMediaItems: MediaItemBase[]) {
		return new this(tMediaItems);
	}
	/**
	 * The tracks/videos selected in a track list on the open page (album, playlist, My Collection …), in the order TIDAL
	 * lists them. `undefined` if nothing is selected. The selection is TIDAL's own, the one its context menu uses.
	 */
	public static fromSelection(): MediaItems | undefined {
		const getters = new Set<() => ItemId[]>();
		for (const row of trackTableRows()) {
			const getSelected = trackTableProps<{ getSelectedMediaItemIds: () => ItemId[] }>(row, "getSelectedMediaItemIds")?.getSelectedMediaItemIds;
			// Every row of a table passes down the same getter, ask each table once
			if (getSelected === undefined || getters.has(getSelected)) continue;
			getters.add(getSelected);
			const ids = getSelected();
			if (ids.length === 0) continue;
			const mediaItems = (<{ content?: { mediaItems?: Record<string, { type?: redux.ContentType }> } }>redux.store.getState()).content?.mediaItems;
			return new this(ids.map((id) => ({ item: { id }, type: mediaItems?.[id]?.type ?? "track" })));
		}
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
