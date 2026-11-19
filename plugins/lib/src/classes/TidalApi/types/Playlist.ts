import type { components } from "@tidal-music/api";

/** An entry of a playlist, `meta.itemId` identifies it in the playlist: duplicates of a track each have their own */
export type TApiPlaylistItemRef = components["schemas"]["PlaylistsItemsRelationshipRemoveOperation_Payload_Data"];
