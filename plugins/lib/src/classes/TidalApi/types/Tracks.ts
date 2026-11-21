import type { components } from "@tidal-music/api";

/** A track from TIDAL's OpenAPI, e.g. `GET /tracks?filter[isrc]=` */
export type TApiTrack = components["schemas"]["Tracks_Resource_Object"];
/** A page of tracks from TIDAL's OpenAPI */
export type TApiTracks = components["schemas"]["Tracks_Multi_Resource_Data_Document"];
