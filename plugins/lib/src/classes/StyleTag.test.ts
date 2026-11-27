import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { LunaUnload } from "@luna/core";

import { StyleTag } from "./StyleTag";

let unloads: Set<LunaUnload>;

beforeEach(() => {
	unloads = new Set();
	document.head.innerHTML = "";
	document.body.innerHTML = "";
});

afterEach(() => {
	for (const unload of [...unloads]) unload();
	document.head.innerHTML = "";
	document.body.innerHTML = "";
});

const styleInHead = (id: string) => document.getElementById(id) as HTMLStyleElement | null;

describe("constructor", () => {
	test("creates a style tag with the given id and adds it to the document head", () => {
		const tag = new StyleTag("luna-style-a", unloads, "body { color: red; }");

		const element = styleInHead("luna-style-a");
		expect(element).toBe(tag.styleTag);
		expect(element?.tagName).toBe("STYLE");
		expect(element?.parentNode).toBe(document.head);
		expect(element?.innerHTML).toBe("body { color: red; }");
	});

	test("trims the css it is given", () => {
		const tag = new StyleTag("luna-style-b", unloads, "  body { color: red; }  ");

		expect(tag.css).toBe("body { color: red; }");
		expect(styleInHead("luna-style-b")?.innerHTML).toBe("body { color: red; }");
	});

	test("reuses an element that already has the given id", () => {
		const existing = document.createElement("style");
		existing.id = "luna-style-c";
		document.head.appendChild(existing);

		const tag = new StyleTag("luna-style-c", unloads, "a { color: blue; }");

		expect(tag.styleTag).toBe(existing);
		expect(styleInHead("luna-style-c")).toBe(existing);
		expect(existing.innerHTML).toBe("a { color: blue; }");
	});

	test("removes an existing element when it is given no css", () => {
		const existing = document.createElement("style");
		existing.id = "luna-style-d";
		existing.innerHTML = "stale";
		document.head.appendChild(existing);

		const tag = new StyleTag("luna-style-d", unloads);

		// Setting the css adds the tag, an empty css removes it
		expect(tag.css).toBeUndefined();
		expect(existing.isConnected).toBe(false);
		expect(tag.styleTag).toBe(existing);
	});

	test("creates a tag without an id when given an empty one", () => {
		const tag = new StyleTag("", unloads, "a { color: blue; }");

		expect(tag.id).toBe("");
		expect(tag.styleTag.id).toBe("");
		expect(tag.styleTag.isConnected).toBe(true);
		expect(document.querySelectorAll("style").length).toBe(1);
	});
});

describe("css", () => {
	test("updates the tag it is already connected to", () => {
		const tag = new StyleTag("luna-style-e", unloads, "a { color: blue; }");

		tag.css = "a { color: green; }";

		expect(tag.css).toBe("a { color: green; }");
		expect(styleInHead("luna-style-e")?.innerHTML).toBe("a { color: green; }");
		// Updated in place, not replaced
		expect(styleInHead("luna-style-e")).toBe(tag.styleTag);
		expect(document.querySelectorAll("style").length).toBe(1);
	});

	test("adds the tag again when it was removed", () => {
		const tag = new StyleTag("luna-style-f", unloads, "a { color: blue; }");
		tag.remove();
		expect(tag.styleTag.isConnected).toBe(false);

		tag.css = "a { color: green; }";

		expect(tag.styleTag.isConnected).toBe(true);
		expect(styleInHead("luna-style-f")).toBe(tag.styleTag);
	});

	test("removes the tag from the document when set to undefined", () => {
		const tag = new StyleTag("luna-style-g", unloads, "a { color: blue; }");

		tag.css = undefined;

		expect(tag.css).toBeUndefined();
		expect(tag.styleTag.isConnected).toBe(false);
		expect(styleInHead("luna-style-g")).toBeNull();
	});

	test("removes the tag from the document when set to whitespace", () => {
		const tag = new StyleTag("luna-style-h", unloads, "a { color: blue; }");

		tag.css = "   ";

		expect(tag.css).toBe("");
		expect(tag.styleTag.isConnected).toBe(false);
	});
});

describe("remote css is text, never markup", () => {
	/**
	 * A theme is remote CSS injected into TIDAL's own page, so what it can produce matters. `<style>` is a rawtext
	 * element, so markup in its content should stay text; these tests pin that down rather than trusting the parser to
	 * keep being right.
	 */
	const payload = 'body{color:red}</style><img src=x onerror="window.__pwned=1"><script>window.__pwned=1<\/script>';

	test("does not create elements from the css", () => {
		const style = new StyleTag("remote", unloads);
		style.css = payload;

		expect(document.querySelector("img")).toBeNull();
		expect(document.querySelector("script")).toBeNull();
		expect(style.styleTag.children.length).toBe(0);
	});

	test("keeps the payload as the tag's text, so the stylesheet rule is unchanged", () => {
		const style = new StyleTag("remote", unloads);
		style.css = payload;

		expect(style.styleTag.textContent).toBe(payload);
		expect(style.css).toBe(payload);
	});

	test("does not execute anything from the css", () => {
		(window as unknown as { __pwned?: number }).__pwned = undefined;
		const style = new StyleTag("remote", unloads);
		style.css = payload;

		expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
	});
});

describe("add and remove", () => {
	test("add() puts the tag in the document head", () => {
		const tag = new StyleTag("luna-style-i", unloads, "a { color: blue; }");
		tag.remove();

		tag.add();

		expect(tag.styleTag.parentNode).toBe(document.head);
	});

	test("remove() takes the tag out of the document", () => {
		const tag = new StyleTag("luna-style-j", unloads, "a { color: blue; }");

		tag.remove();

		expect(tag.styleTag.isConnected).toBe(false);
		expect(styleInHead("luna-style-j")).toBeNull();
	});

	test("remove() of a tag that isn't in the document is a no-op", () => {
		const tag = new StyleTag("luna-style-k", unloads);
		expect(tag.styleTag.isConnected).toBe(false);

		expect(() => tag.remove()).not.toThrow();
		expect(() => tag.remove()).not.toThrow();
	});
});

describe("unload", () => {
	test("unloading removes the style tag from the document", () => {
		const tag = new StyleTag("luna-style-l", unloads, "a { color: blue; }");
		expect(tag.styleTag.isConnected).toBe(true);
		expect(unloads.size).toBe(1);

		for (const unload of [...unloads]) unload();

		expect(tag.styleTag.isConnected).toBe(false);
		expect(styleInHead("luna-style-l")).toBeNull();
	});

	test("unloading one tag leaves the other tags in the document", () => {
		const first = new StyleTag("luna-style-m", unloads, "a { color: blue; }");
		const second = new StyleTag("luna-style-n", unloads, "b { color: blue; }");

		for (const unload of [...unloads]) unload();

		expect(first.styleTag.isConnected).toBe(false);
		expect(second.styleTag.isConnected).toBe(false);
		expect(document.querySelectorAll("style").length).toBe(0);
	});
});
