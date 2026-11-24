import { beforeEach, describe, expect, it } from "vitest";

import { resetTidalState, setTidalState } from "test/harness/tidalStore";

import { contentInstances } from "../caches";
import type * as redux from "../redux";
import { ContentBase } from "./ContentBase";

class TestContent extends ContentBase {
	public constructor(
		public readonly id: redux.ItemId,
		public readonly item?: redux.Album,
	) {
		super();
	}

	public static load(id: redux.ItemId, build: (item?: redux.Album) => Promise<TestContent | undefined> | TestContent | undefined) {
		return ContentBase.fromStore<"albums", typeof TestContent, TestContent>(id, "albums", build);
	}
}

let idSeq = 500_000;
const nextId = () => ++idSeq;

beforeEach(() => {
	resetTidalState();
	setTidalState({ content: { mediaItems: {}, albums: {}, artists: {} } as never });
});

describe("ContentBase.fromStore", () => {
	it("returns the cached instance without calling generator again", async () => {
		const id = nextId();
		let calls = 0;
		const first = await TestContent.load(id, () => {
			calls++;
			return new TestContent(id);
		});
		const second = await TestContent.load(id, () => {
			calls++;
			return new TestContent(id);
		});
		expect(second).toBe(first);
		expect(calls).toBe(1);
	});

	it("preserves instance identity via WeakRefs when evicted from the bounded cache and re-promotes it", async () => {
		const id = nextId();
		const { cache } = contentInstances("albums");
		const first = await TestContent.load(id, () => new TestContent(id));
		expect(cache.has(String(id))).toBe(true);

		cache.delete(String(id));
		expect(cache.has(String(id))).toBe(false);

		const restored = await TestContent.load(id, () => new TestContent(id));
		expect(restored).toBe(first);
		expect(cache.has(String(id))).toBe(true);
	});

	it("returns a single instance when concurrent builds race for the same id", async () => {
		const id = nextId();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));

		const firstPending = TestContent.load(id, async () => {
			await gate;
			return new TestContent(id);
		});
		const secondPending = TestContent.load(id, async () => {
			await gate;
			return new TestContent(id);
		});
		release();

		const [first, second] = await Promise.all([firstPending, secondPending]);
		expect(second).toBe(first);
	});
});
