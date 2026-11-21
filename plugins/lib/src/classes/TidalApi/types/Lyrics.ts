import type { components } from "@tidal-music/api";

/** `GET /tracks/{id}?include=lyrics` from TIDAL's OpenAPI, the lyrics are in `included` */
export type TApiTrackWithLyrics = components["schemas"]["Tracks_Single_Resource_Data_Document"];
/** Lyrics of a track from TIDAL's OpenAPI */
export type TApiLyrics = components["schemas"]["Lyrics_Resource_Object"];
