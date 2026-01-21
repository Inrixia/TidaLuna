import { parse, type Manifest as DashManifest } from "dasha";

export type DashaParseArgs = Parameters<typeof parse>;
export { type DashManifest };

export const parseDasha = async (...args: DashaParseArgs): Promise<DashManifest> => JSON.parse(JSON.stringify(await parse(...args)));
