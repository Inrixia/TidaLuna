import appIconBase64 from "file://../assets/brand/app-icon-256.png?base64";

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The window icon, inlined at build time so a Luna install stays the files esbuild wrote. */
export const appIconPng = Buffer.from(appIconBase64, "base64");

/** Guards against a build where the inlined asset is not the PNG it should be. */
export const isAppIconPng = (png: Buffer) => png.subarray(0, pngSignature.length).equals(pngSignature);

/** PNG width and height straight out of the IHDR chunk, for the tests and for logging a broken asset. */
export const appIconSize = (png: Buffer): { width: number; height: number } => {
	if (!isAppIconPng(png)) throw new Error("Not a PNG");
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
};

/**
 * Electron's `nativeImage` is passed in rather than imported so this module can be used without Electron.
 * Returns undefined when the inlined asset is not a PNG, which leaves the window with TIDAL's own icon.
 */
export const createAppIcon = <T>(nativeImage: { createFromBuffer: (png: Buffer) => T }, png: Buffer = appIconPng): T | undefined =>
	isAppIconPng(png) ? nativeImage.createFromBuffer(png) : undefined;
