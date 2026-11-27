import type { BackendStats, CacheStoreBackendBase, StreamRange } from "../cache/CacheStoreBackend";
import { bytesStream, readAll } from "../cache/streams";

/** A backend that only streams, like FsBackend, over a Map in tests */
export class StreamOnlyBackend implements CacheStoreBackendBase<Uint8Array, unknown, false> {
	public readonly sync = false;
	public readonly values = new Map<string, Uint8Array>();
	public async getStream(key: string, _meta?: unknown, range: StreamRange = {}) {
		const value = this.values.get(key);
		return value && bytesStream(value, range.start, range.end === undefined ? undefined : range.end + 1);
	}
	/** Holds the value once the whole stream is read, nothing if it fails */
	public async setStream(key: string, dataStream: ReadableStream<Uint8Array>) {
		const bytes = await readAll(dataStream);
		this.values.set(key, bytes);
		return bytes.byteLength;
	}
	public async del(key: string) {
		this.values.delete(key);
	}
	public async keys() {
		return [...this.values.keys()];
	}
	public async bytesOf(key: string) {
		return this.values.get(key)?.byteLength;
	}
	public stats(): BackendStats {
		return { kind: "streamOnly", entries: this.values.size, reads: 0, writes: 0, errors: 0 };
	}
}
