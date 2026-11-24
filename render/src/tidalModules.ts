/**
 * TIDAL's modules by path, captured by exposeTidalInternals.ts. Kept in its own module so code that only reads it
 * (e.g. helpers/findModule.ts) doesn't import the boot code, which waits for TIDAL's scripts.
 */
export const tidalModules: Record<string, object> = {};
