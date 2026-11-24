// Bytes of one value arriving over time, read by any number of readers at once, each as a stream of the range it wants that waits for bytes not there yet.
// Bytes arrive either in any order into a buffer of known size (`allocate` + `write`, e.g. ranged fetches of audio) or in order with the size known
// only at the end (`append` + `end`, e.g. a stream being cached). Bytes are written once and never change, so readers get views, not copies
import { addRange, filledBytes, filledUntil, gapFrom, type Range } from "./StreamBuffer.ranges";

const MB = 1024 ** 2;

export type StreamBufferOptions = {
	/**
	 * A reader waits at `pos` for bytes that aren't there, e.g. to start fetching from there. It waits for the next `write` (or `wake`)
	 * once this resolves. A rejection ends the reader's stream with the error
	 */
	onWait?: (pos: number) => void | Promise<void>;
	/** Readers started or stopped waiting: called when the first starts and the last stops, e.g. to put their fetches first */
	onWaitingChange?: () => void;
	/** A reader finished, e.g. to free the memory once nobody reads it */
	onRelease?: () => void;
};

export class StreamBuffer {
	/** The bytes, unset until the size is known (`allocate`) or the first `append`. Appending may replace it with a larger copy */
	public data?: Uint8Array;
	/** The ranges of `data` written */
	public readonly ranges: Range[] = [];
	/** Readers holding the buffer now, see `hold` */
	public readers = 0;
	/** Readers waiting for bytes now */
	public waiting = 0;
	/** Bytes the value has once known: the allocated size, or the appended bytes once `end` is called */
	private total?: number;
	/** Why the producer failed, every reader's stream ends with it */
	public error?: unknown;
	/** Called on the next write or `wake` */
	private readonly waiters = new Set<() => void>();

	public constructor(private readonly options: StreamBufferOptions = {}) {}

	/** A complete buffer of `bytes`, a view over the same memory */
	public static of(bytes: Uint8Array): StreamBuffer {
		const buffer = new StreamBuffer();
		buffer.allocate(bytes);
		addRange(buffer.ranges, 0, bytes.byteLength);
		return buffer;
	}

	/** Bytes the value has, once known */
	public get size() {
		return this.total;
	}
	/** Bytes written */
	public get filledBytes() {
		return filledBytes(this.ranges);
	}
	public get complete() {
		return this.total !== undefined && filledUntil(this.ranges, 0) >= this.total;
	}
	/** The whole value once complete, a view over the same memory */
	public get bytes(): Uint8Array | undefined {
		return this.complete ? this.data!.subarray(0, this.total) : undefined;
	}
	/** Where the bytes from `pos` stop being there */
	public filledUntil(pos: number) {
		return filledUntil(this.ranges, pos);
	}
	/** The first range missing from `pos` before `limit` (the size by default), then from the start */
	public gapFrom(pos: number, limit = this.size ?? Infinity) {
		return gapFrom(this.ranges, pos, limit);
	}

	/** Holds the bytes in `data` once the size is known, e.g. `Buffer.allocUnsafe(size)`. Kept if there already is one */
	public allocate(data: Uint8Array) {
		if (this.data === undefined) {
			this.data = data;
			this.total = data.byteLength;
		}
		this.wake();
	}
	/** Writes `chunk` at `pos` of an allocated buffer, past the end is cut off. Wakes the readers */
	public write(pos: number, chunk: Uint8Array) {
		if (this.data === undefined || this.total === undefined) throw new Error("StreamBuffer written before allocate");
		const end = Math.min(pos + chunk.byteLength, this.total);
		if (end <= pos) return;
		this.data.set(chunk.subarray(0, end - pos), pos);
		addRange(this.ranges, pos, end);
		this.wake();
	}
	/**
	 * Adds `chunk` after the bytes appended so far, for a value whose size is known only at the end. The buffer doubles when full: readers
	 * keep their views of the old one, which holds the same bytes. Wakes the readers
	 */
	public append(chunk: Uint8Array) {
		if (this.total !== undefined) throw new Error("StreamBuffer appended to after its size is known");
		const pos = filledUntil(this.ranges, 0);
		const end = pos + chunk.byteLength;
		if (this.data === undefined || end > this.data.byteLength) {
			const grown = new Uint8Array(Math.max(end, (this.data?.byteLength ?? 0) * 2, 64 * 1024));
			if (this.data !== undefined) grown.set(this.data.subarray(0, pos));
			this.data = grown;
		}
		this.data.set(chunk, pos);
		if (end > pos) addRange(this.ranges, pos, end);
		this.wake();
	}
	/** Every byte is appended: the size is the bytes appended. A buffer over a quarter empty is copied to its size, readers keep their views */
	public end() {
		const size = filledUntil(this.ranges, 0);
		if (this.data === undefined) this.data = new Uint8Array(0);
		else if (this.data.byteLength - size > this.data.byteLength / 4) this.data = this.data.slice(0, size);
		this.total = size;
		this.wake();
	}
	/** The producer failed: every reader's stream, waiting or not, ends with `error` */
	public fail(error: unknown) {
		this.error = error;
		this.wake();
	}
	/** Drops the bytes, e.g. once they are on disk. Only when nothing holds it */
	public clear() {
		this.data = undefined;
		this.total = undefined;
		this.ranges.length = 0;
	}

	/** Lets every waiting reader check again, e.g. once a fetch stopped short */
	public wake() {
		for (const waiter of this.waiters) waiter();
		this.waiters.clear();
	}
	/** Resolves on the next write or `wake`, without waiting as a reader */
	public nextChange(): Promise<void> {
		return new Promise((resolve) => this.waiters.add(resolve));
	}
	/** Counts a reader (so the buffer isn't cleared under it) until the returned function is called */
	public hold(): () => void {
		this.readers++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.readers--;
			this.options.onRelease?.();
		};
	}

	/** Waits as a reader at `pos` (see `onWait`) for the next write or `wake`, or until `signal` aborts */
	private async waitAt(pos: number, signal: AbortSignal) {
		if (signal.aborted) return;
		let wake!: () => void;
		const woken = new Promise<void>((resolve) => (wake = resolve));
		signal.addEventListener("abort", wake);
		this.waiters.add(wake);
		if (this.waiting++ === 0) this.options.onWaitingChange?.();
		try {
			await this.options.onWait?.(pos);
			await woken;
		} finally {
			this.waiters.delete(wake);
			signal.removeEventListener("abort", wake);
			if (--this.waiting === 0) this.options.onWaitingChange?.();
		}
	}

	/** The size once known, waiting as a reader at `pos` (where it will read from) until then. `undefined` if `signal` aborted first. `hold` it around this */
	public async sizeFrom(pos: number, signal: AbortSignal): Promise<number | undefined> {
		while (this.total === undefined && !signal.aborted) {
			if (this.error !== undefined) throw this.error;
			await this.waitAt(pos, signal);
		}
		return this.size;
	}

	/**
	 * Bytes `start` to `end` (exclusive, the end of the value by default) as a stream of chunks of at most 1MB, each as soon as it is there.
	 * Holds the buffer until it ends, errors or is cancelled, or `signal` aborts
	 */
	public stream(start = 0, end?: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
		const release = this.hold();
		const cancelled = new AbortController();
		const abort = () => cancelled.abort();
		signal?.addEventListener("abort", abort, { once: true });
		const finish = () => {
			signal?.removeEventListener("abort", abort);
			release();
		};
		let pos = start;
		return new ReadableStream<Uint8Array>(
			{
				pull: async (controller) => {
					try {
						while (!cancelled.signal.aborted) {
							if (this.error !== undefined) throw this.error;
							const stop = Math.min(end ?? Infinity, this.total ?? Infinity);
							if (pos >= stop) {
								finish();
								return controller.close();
							}
							const until = Math.min(this.filledUntil(pos), stop, pos + MB);
							if (this.data !== undefined && until > pos) {
								controller.enqueue(this.data.subarray(pos, until));
								pos = until;
								return;
							}
							await this.waitAt(pos, cancelled.signal);
						}
						// Aborted by `signal`
						finish();
						controller.error(signal?.reason ?? new DOMException("Aborted", "AbortError"));
					} catch (err) {
						finish();
						controller.error(err);
					}
				},
				// A reader waiting for bytes puts its fetch first, it must not outlast its stream
				cancel: () => {
					cancelled.abort();
					finish();
				},
			},
			// Pulled only when the reader wants more, so bytes aren't queued ahead of a slow reader
			{ highWaterMark: 0 },
		);
	}
}
