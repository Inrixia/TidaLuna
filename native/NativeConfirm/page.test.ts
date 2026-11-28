import { describe, expect, it } from "vitest";

import { escapeHtml, NOTE, promptPage, SUBMIT } from "./page";

describe("prompt page", () => {
	it("escapes html", () => {
		expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
	});

	it("blocks everything but its own inline style and script", () => {
		const html = promptPage({ title: "T", style: "", body: "", script: "" });
		expect(html).toMatch(/content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"/);
	});

	it("escapes its title", () => {
		const html = promptPage({ title: "</title><script>x()</script>", style: "", body: "", script: "" });
		expect(html.includes("<script>x()")).toBe(false);
	});

	it("answers and notes through the title, and keeps armed buttons disabled until main arms them", () => {
		const html = promptPage({ title: "T", style: "", body: "", script: "" });
		expect(html).toMatch(new RegExp(`const submit = \\(answer\\) => \\(document\\.title = "${SUBMIT}" \\+ answer\\)`));
		expect(html).toMatch(new RegExp(`document\\.title = "${NOTE}" \\+ what \\+ "#" \\+ \\+\\+notes`));
		expect(html).toMatch(/for \(const button of document\.querySelectorAll\("button\[data-arm\]"\)\) button\.disabled = true;/);
		expect(html).toMatch(/button\.disabled = !armed/);
	});
});
