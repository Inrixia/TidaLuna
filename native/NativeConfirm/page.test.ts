import assert from "node:assert";
import { describe, it } from "node:test";

import { escapeHtml, NOTE, promptPage, SUBMIT } from "./page";

describe("prompt page", () => {
	it("escapes html", () => {
		assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
	});

	it("blocks everything but its own inline style and script", () => {
		const html = promptPage({ title: "T", style: "", body: "", script: "" });
		assert.match(html, /content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"/);
	});

	it("escapes its title", () => {
		const html = promptPage({ title: "</title><script>x()</script>", style: "", body: "", script: "" });
		assert.equal(html.includes("<script>x()"), false);
	});

	it("answers and notes through the title, and keeps armed buttons disabled until main arms them", () => {
		const html = promptPage({ title: "T", style: "", body: "", script: "" });
		assert.match(html, new RegExp(`const submit = \\(answer\\) => \\(document\\.title = "${SUBMIT}" \\+ answer\\)`));
		assert.match(html, new RegExp(`document\\.title = "${NOTE}" \\+ what \\+ "#" \\+ \\+\\+notes`));
		assert.match(html, /for \(const button of document\.querySelectorAll\("button\[data-arm\]"\)\) button\.disabled = true;/);
		assert.match(html, /button\.disabled = !armed/);
	});
});
