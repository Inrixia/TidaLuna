// Rough heap bytes of a value held in memory, for memory backends to size what they hold. V8 doesn't expose real sizes, so this walks the
// object graph with typical costs: a 16 byte object header plus 8 per property slot, 16 + 8 per array element, ~12 + 2 per string char
// (two byte strings, the worst case), binary data by its length. Each object counts once, so shared and cyclic references aren't counted twice
const objectBytes = 16;
const slotBytes = 8;

const estimate = (value: unknown, seen: Set<object>): number => {
	switch (typeof value) {
		case "string":
			return 12 + 2 * value.length;
		case "number":
		case "boolean":
		case "symbol":
			return slotBytes;
		case "bigint":
			return 16 + Math.ceil(value.toString(16).length / 2);
		case "undefined":
		case "function":
			return 0;
	}
	if (value === null) return 0;
	const object = <object>value;
	if (seen.has(object)) return 0;
	seen.add(object);

	if (ArrayBuffer.isView(object)) return objectBytes + object.byteLength;
	if (object instanceof ArrayBuffer) return objectBytes + object.byteLength;
	if (typeof Blob !== "undefined" && object instanceof Blob) return objectBytes + object.size;
	let bytes = objectBytes;
	if (Array.isArray(object)) {
		bytes += slotBytes * object.length;
		for (const item of object) bytes += estimate(item, seen);
		return bytes;
	}
	if (object instanceof Map) {
		for (const [key, item] of object) bytes += 2 * slotBytes + estimate(key, seen) + estimate(item, seen);
		return bytes;
	}
	if (object instanceof Set) {
		for (const item of object) bytes += slotBytes + estimate(item, seen);
		return bytes;
	}
	// A promise's value can't be read synchronously, `CacheStore` sizes it once settled
	if (object instanceof Promise) return bytes;
	for (const key in object) bytes += slotBytes + estimate((<Record<string, unknown>>object)[key], seen);
	return bytes;
};

/** Rough heap bytes `value` takes, see the note above */
export const estimateMemory = (value: unknown): number => estimate(value, new Set());
