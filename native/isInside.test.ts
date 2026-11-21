// Run: pnpm exec tsx --test native/isInside.test.ts
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { isInside } from "./isInside";

const dir = path.resolve("resources", "app");

test("isInside", () => {
	assert.equal(isInside(dir, path.join(dir, "luna.mjs")), true);
	assert.equal(isInside(dir, path.join(dir, "sub", "file.css")), true);
	assert.equal(isInside(dir, dir), true);
	assert.equal(isInside(dir, path.join(dir, "..foo")), true);
	assert.equal(isInside(dir, path.join(dir, "..", "x")), false);
	assert.equal(isInside(dir, path.join(dir, "..")), false);
	assert.equal(isInside(dir, path.join(dir, "..", "app-old", "x")), false);
	assert.equal(isInside(dir, path.join(dir + "-old", "x")), false);
});
