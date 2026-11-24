/**
 * Objects by key, held weakly: one stays reachable here while anything else references it, so callers asking for a key again get the same
 * object (e.g. a `MediaItem` evicted from its bounded cache but still held by a component). Keys of collected objects are dropped
 */
export class WeakRefs<V extends object> {
	private readonly refs = new Map<string, WeakRef<V>>();
	// The key is dropped only if it still names the collected object, not one set since
	private readonly registry = new FinalizationRegistry<string>((key) => {
		if (this.refs.get(key)?.deref() === undefined) this.refs.delete(key);
	});

	/** The object of `key` if it is still alive */
	public get(key: string): V | undefined {
		return this.refs.get(key)?.deref();
	}
	public set(key: string, value: V): V {
		this.refs.set(key, new WeakRef(value));
		this.registry.register(value, key);
		return value;
	}
	public delete(key: string) {
		this.refs.delete(key);
	}
	/** Keys held, some of whose objects may be collected but not yet finalized */
	public get size() {
		return this.refs.size;
	}
}
