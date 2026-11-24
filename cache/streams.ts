// Moving binary values between whole values and streams, for caches holding large ones (audio)
const MB = 1024 ** 2;

/** `value` as bytes, a view over the same memory. Throws for anything else: only binary values can be streamed */
export const toBytes = (value: unknown): Uint8Array => {
	if (value instanceof Uint8Array) return value;
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	throw new TypeError("Only binary values can be streamed");
};

/** Bytes `start` to `end` (exclusive) of `bytes` as a stream, in chunks of at most `chunkBytes` (1MB) that are views, not copies */
export const bytesStream = (bytes: Uint8Array, start = 0, end = bytes.byteLength, chunkBytes = MB): ReadableStream<Uint8Array> => {
	let pos = start;
	return new ReadableStream({
		pull(controller) {
			if (pos >= end) return controller.close();
			const next = Math.min(pos + chunkBytes, end);
			controller.enqueue(bytes.subarray(pos, next));
			pos = next;
		},
	});
};

/** Every byte of `stream`, in one array */
export const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for await (const chunk of stream) {
		chunks.push(chunk);
		bytes += chunk.byteLength;
	}
	const all = new Uint8Array(bytes);
	let pos = 0;
	for (const chunk of chunks) {
		all.set(chunk, pos);
		pos += chunk.byteLength;
	}
	return all;
};
