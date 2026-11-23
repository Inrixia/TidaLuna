import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { Cache } from "./Cache";

mock.timers.enable({ apis: ["Date"] });
const day = 24 * 60 * 60_000;

test("evicts the least recently read, a write alone doesn't keep an entry", () => {
	const cache = new Cache<string>({ maxEntries: 3 });
	for (const key of ["a", "b", "c"]) {
		cache.set(key, key);
		mock.timers.tick(1000);
	}
	cache.get("a");
	mock.timers.tick(1000);
	cache.set("b", "b2"); // rewrite is not a read
	cache.set("d", "d");
	assert.deepEqual([...cache.keys()].sort(), ["a", "c", "d"]);
	assert.equal(cache.has("b"), false);
});

test("frequently read entries outlast a newer one read once", () => {
	const cache = new Cache<string>({ maxEntries: 2 });
	cache.set("popular", "p");
	for (let i = 0; i < 5; i++) {
		mock.timers.tick(1000);
		cache.get("popular");
	}
	mock.timers.tick(60_000);
	cache.set("recent", "r");
	mock.timers.tick(60_000);
	cache.set("newest", "n");
	assert.equal(cache.has("popular"), true);
	assert.equal(cache.has("recent"), false);
});

test("what was read long ago decays", () => {
	const cache = new Cache<string>({ maxEntries: 2 });
	cache.set("old", "o");
	for (let i = 0; i < 3; i++) cache.get("old");
	mock.timers.tick(60 * day);
	cache.set("a", "a");
	mock.timers.tick(1000);
	cache.set("b", "b");
	assert.equal(cache.has("old"), false);
});

test("bytes limit, pinned entries and stats", () => {
	const evicted: string[] = [];
	const cache = new Cache<string>({ maxBytes: 100, isPinned: (key) => key === "pin", onEvict: (key) => evicted.push(key) });
	cache.set("pin", "x", 60);
	mock.timers.tick(1000);
	cache.set("a", "x", 30);
	mock.timers.tick(1000);
	cache.set("b", "x", 30);
	assert.deepEqual(evicted, ["a"]);
	assert.equal(cache.usage, 90);
	cache.get("b", 30);
	cache.get("missing");
	const stats = cache.stats();
	assert.deepEqual([stats.hits, stats.misses, stats.readBytes, stats.evictions, stats.evictedBytes], [1, 1, 30, 1, 30]);
	cache.maxBytes = 70;
	cache.evict();
	assert.equal(cache.has("pin"), true);
	assert.equal(cache.has("b"), false);
});
