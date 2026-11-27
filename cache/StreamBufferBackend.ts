import type { BackendStats, CacheStoreBackendBase, InFlightStream, StreamRange } from "./CacheStoreBackend";
import { StreamBuffer } from "./StreamBuffer";

/**
 * Binary values in memory as `StreamBuffer`s, readable while they are streamed in: each `getStream` is its own reader of the one buffer,
 * getting views rather than copies, and holds the value from eviction (`pinned`) until it ends. The memory backend of streamed caches
 */
export class StreamBufferBackend implements CacheStoreBackendBase<Uint8Array, unknown, true> {
	public readonly sync = true;
	private readonly buffers = new Map<string, StreamBuffer>();
	private reads = 0;
	private writes = 0;
	private errors = 0;

	/** The whole value, once streamed in */
	public get(key: string): Uint8Array | undefined {
		this.reads++;
		return this.buffers.get(key)?.bytes;
	}
	public set(key: string, data: Uint8Array): void {
		this.writes++;
		this.buffers.set(key, StreamBuffer.of(data));
	}
	public getStream(key: string, _meta?: unknown, range: StreamRange = {}): ReadableStream<Uint8Array> | undefined {
		const buffer = this.buffers.get(key);
		if (buffer === undefined) return undefined;
		this.reads++;
		return buffer.stream(range.start, range.end === undefined ? undefined : range.end + 1, range.signal);
	}
	/** Readable by `getStream` as soon as this is called. A failed stream fails its readers and leaves nothing behind */
	public async setStream(key: string, dataStream: ReadableStream<Uint8Array>): Promise<number> {
		const buffer = new StreamBuffer();
		this.buffers.set(key, buffer);
		this.writes++;
		try {
			for await (const chunk of dataStream) buffer.append(chunk);
			buffer.end();
			return buffer.size!;
		} catch (err) {
			this.errors++;
			buffer.fail(err);
			if (this.buffers.get(key) === buffer) this.buffers.delete(key);
			throw err;
		}
	}
	public del(key: string): void {
		this.buffers.delete(key);
	}
	public keys(): Iterable<string> {
		return this.buffers.keys();
	}
	public sizeOf(data: Uint8Array): number {
		return data.byteLength;
	}
	/** Held while a reader is reading it */
	public pinned(key: string): boolean {
		return (this.buffers.get(key)?.readers ?? 0) > 0;
	}
	public stats(): BackendStats {
		const inFlight: InFlightStream[] = [];
		for (const [key, buffer] of this.buffers) {
			if (buffer.size === undefined) inFlight.push({ key, filledBytes: buffer.filledBytes, readers: buffer.readers });
		}
		return { kind: "streamBuffer", entries: this.buffers.size, reads: this.reads, writes: this.writes, errors: this.errors, inFlight };
	}
}
