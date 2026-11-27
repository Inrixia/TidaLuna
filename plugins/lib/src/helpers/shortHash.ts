/** First 12 hex digits of a hash, enough to tell versions apart and compare with a published hash. `?` when unknown */
export const shortHash = (hash?: string): string => (hash === undefined ? "?" : hash.slice(0, 12));
