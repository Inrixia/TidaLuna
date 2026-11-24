import type { MaybePromise } from "@inrixia/helpers";

/**
 * Bytes a value takes, roughly: the length of binary data, a string's length, otherwise the length of its JSON.
 * A promise is sized once it resolves. Caches use this unless given their own `CacheOptions.sizeOf`
 */
export const sizeOf = (value: unknown): MaybePromise<number> => {
	if (value instanceof Promise) return value.then(sizeOf);
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value.byteLength;
	if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
	if (typeof value === "string") return value.length;
	if (value === undefined) return 0;
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		// Cyclic or holds a BigInt
		return 0;
	}
};
