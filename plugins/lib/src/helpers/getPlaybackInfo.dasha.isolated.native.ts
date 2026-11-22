import { parse, type Manifest as DashManifest } from "dasha";

export type DashaParseArgs = Parameters<typeof parse>;
export { type DashManifest };

// Runs without network (isolated): DASH manifests only. An HLS playlist would need its media playlists fetched
export const parseDasha = async (...args: DashaParseArgs): Promise<DashManifest> => JSON.parse(JSON.stringify(await parse(...args)));
