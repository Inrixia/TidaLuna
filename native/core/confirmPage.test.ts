import assert from "node:assert";
import { describe, it } from "node:test";

import {
	actionToRun,
	ANSWER_IN_USE_MS,
	buildConfirmHtml,
	confirmGate,
	confirmLinks,
	confirmRequest,
	COOL_DOWN_MS,
	httpLink,
	MAX_CANCELS,
	MAX_PENDING,
	shownWarning,
	type TidalState,
} from "./confirmPage";

const FOCUSED: TidalState = { visible: true, focused: true, recentUserInput: false };
const AWAY: TidalState = { visible: true, focused: false, recentUserInput: false };

describe("core confirmation gate", () => {
	it("refuses while TIDAL is not in use", () => {
		const gate = confirmGate();
		assert.equal(gate.refuse({ tidal: AWAY, now: 0 }), "TIDAL is not in use");
		assert.equal(gate.pending, 0);
	});

	it("takes recent input in TIDAL when focus isn't reported, but never a hidden TIDAL", () => {
		const gate = confirmGate();
		assert.equal(gate.refuse({ tidal: { ...AWAY, recentUserInput: true }, now: 0 }), undefined);
		assert.equal(gate.refuse({ tidal: { visible: false, focused: true, recentUserInput: true }, now: 0 }), "TIDAL is not in use");
	});

	it("takes an answer in a confirmation window as using TIDAL for a while", () => {
		const gate = confirmGate();
		assert.equal(gate.refuse({ tidal: FOCUSED, now: 0 }), undefined);
		gate.answered(true, 100);
		assert.equal(gate.refuse({ tidal: AWAY, now: 100 + ANSWER_IN_USE_MS - 1 }), undefined);
		gate.answered(false, 200);
		assert.equal(gate.refuse({ tidal: AWAY, now: 200 + ANSWER_IN_USE_MS }), "TIDAL is not in use");
		// A window that was never shown is not an answer
		assert.equal(gate.refuse({ tidal: FOCUSED, now: 300 }), undefined);
		gate.answered(undefined, 300);
		assert.equal(gate.refuse({ tidal: AWAY, now: 200 + ANSWER_IN_USE_MS }), "TIDAL is not in use");
	});

	it("stops taking the answer once the user leaves TIDAL", () => {
		const gate = confirmGate();
		assert.equal(gate.refuse({ tidal: FOCUSED, now: 0 }), undefined);
		gate.answered(false, 0);
		gate.left();
		assert.equal(gate.refuse({ tidal: AWAY, now: 1 }), "TIDAL is not in use");
	});

	it("lets only a few wait at once", () => {
		const gate = confirmGate();
		for (let i = 0; i < MAX_PENDING; i++) assert.equal(gate.refuse({ tidal: FOCUSED, now: 0 }), undefined);
		assert.match(gate.refuse({ tidal: FOCUSED, now: 0 })!, /already waiting/);
		gate.answered(true, 0);
		assert.equal(gate.refuse({ tidal: FOCUSED, now: 0 }), undefined);
	});

	it("cools down after cancels in a row, an accept resets", () => {
		const gate = confirmGate();
		const ask = (now: number) => gate.refuse({ tidal: FOCUSED, now });
		for (let i = 0; i < MAX_CANCELS - 1; i++) {
			assert.equal(ask(i), undefined);
			gate.answered(false, i);
		}
		assert.equal(ask(10), undefined);
		gate.answered(true, 10);
		for (let i = 0; i < MAX_CANCELS; i++) {
			assert.equal(ask(20 + i), undefined);
			gate.answered(false, 20 + i);
		}
		assert.match(ask(100)!, /cancelled in a row/);
		assert.equal(ask(20 + MAX_CANCELS + COOL_DOWN_MS), undefined);
	});

	it("doesn't count windows that were never shown", () => {
		const gate = confirmGate();
		for (let i = 0; i < MAX_CANCELS * 2; i++) {
			assert.equal(gate.refuse({ tidal: FOCUSED, now: i }), undefined);
			gate.answered(undefined, i);
		}
		assert.equal(gate.pending, 0);
	});

	it("doesn't count cancels long apart", () => {
		const gate = confirmGate();
		for (let i = 0; i < MAX_CANCELS * 2; i++) {
			const now = i * (COOL_DOWN_MS + 1);
			assert.equal(gate.refuse({ tidal: FOCUSED, now }), undefined);
			gate.answered(false, now);
		}
	});
});

describe("core confirmation page", () => {
	it("escapes what it shows", () => {
		const html = buildConfirmHtml({
			title: "<img src=x onerror=alert(1)>",
			lines: ['a "b" & </p><script>x()</script>'],
			confirmText: "<b>Go</b>",
		});
		assert.equal(html.includes("<img src=x"), false);
		assert.equal(html.includes("<script>x()"), false);
		assert.equal(html.includes("<b>Go</b>"), false);
		assert.equal(html.includes("&lt;img src=x onerror=alert(1)&gt;"), true);
	});

	it("starts with the confirm button disabled and Cancel focused", () => {
		const html = buildConfirmHtml({ title: "T", lines: [], confirmText: "Install" });
		assert.match(html, /<button id="confirm" disabled>Install<\/button>/);
		assert.match(html, /getElementById\("cancel"\)\.focus\(\)/);
		// Main disarms it while another window has the focus
		assert.match(html, /window\.disarm = \(\) => \(confirmButton\.disabled = true\)/);
	});

	it("checks requests that come over IPC", () => {
		assert.deepEqual(confirmRequest("T", ["a"], "Go"), { title: "T", lines: ["a"], confirmText: "Go" });
		assert.throws(() => confirmRequest(1, [], "Go"));
		assert.throws(() => confirmRequest("T", "a", "Go"));
		assert.throws(() => confirmRequest("T", [{}], "Go"));
		assert.throws(() => confirmRequest("", [], "Go"));
		assert.throws(() => confirmRequest("T", new Array(13).fill("a"), "Go"));
		assert.equal(confirmRequest("x".repeat(700), [], "Go").title.length, 601);
	});

	it("takes http(s) links only, and a warning only with an action to run", () => {
		const link = { text: "v2", href: "https://example.com/owner/repo/commit/abc1234" };
		assert.deepEqual(confirmRequest("T", [["a ", link]], "Go").lines, [["a ", link]]);
		assert.throws(() => confirmRequest("T", [[{ text: "x", href: "javascript:alert(1)" }]], "Go"));
		assert.throws(() => confirmRequest("T", [[{ text: "x", href: "file:///C:/x" }]], "Go"));
		assert.throws(() => confirmRequest("T", [[{ text: "x" }]], "Go"));
		assert.throws(() => confirmRequest("T", [[1]], "Go"));
		const run = () => {};
		assert.equal(shownWarning(confirmRequest("T", [], "Go", { text: "w", action: "Ask again", done: "d", run }))?.run, run);
		assert.throws(() => confirmRequest("T", [], "Go", { text: "w", action: "Ask again", done: "d" }));
		assert.throws(() => confirmRequest("T", [], "Go", { text: 1, action: "Ask again", done: "d", run }));
	});

	it("numbers its links in the order main opens them, and escapes them", () => {
		const request = confirmRequest(
			"T",
			["plain", ["a ", { text: "<b>one</b>", href: "https://a.example/1?x=1&y=2" }], [{ text: "two", href: "http://b.example" }]],
			"Go",
		);
		// Normalized: b.example's path gets its slash
		assert.deepEqual(confirmLinks(request), ["https://a.example/1?x=1&y=2", "http://b.example/"]);
		const html = buildConfirmHtml({ ...request, warning: shownWarning(request) });
		assert.match(html, /<a href="#" data-link="0" title="https:\/\/a\.example\/1\?x=1&amp;y=2">&lt;b&gt;one&lt;\/b&gt;<\/a>/);
		assert.match(html, /<a href="#" data-link="1" title="http:\/\/b\.example\/">two<\/a>/);
		assert.equal(html.includes("<b>one</b>"), false);
	});

	it("shows a warning with its own button only when there is one", () => {
		const warning = { text: "<i>Allowed</i>", action: "Ask again", done: "Asks again", run: () => {} };
		const html = buildConfirmHtml({ title: "T", lines: [], confirmText: "Go", warning });
		assert.match(html, /<span id="warning-text">&lt;i&gt;Allowed&lt;\/i&gt;<\/span><button id="warning-action">Ask again<\/button>/);
		assert.equal(buildConfirmHtml({ title: "T", lines: [], confirmText: "Go" }).includes('id="warning-text"'), false);
	});

	it("takes a warning given as a function when the window shows, and checks it then", () => {
		let state: string | undefined;
		const request = confirmRequest("T", [], "Go", () =>
			state === undefined ? undefined : { text: state, action: "A", done: "D", run: () => {} },
		);
		assert.equal(shownWarning(request), undefined);
		state = "now";
		assert.equal(shownWarning(request)?.text, "now");
		const bad = confirmRequest("T", [], "Go", () => ({ text: "w", action: "A", done: "D" }));
		assert.throws(() => shownWarning(bad));
	});

	it("runs the warning's action only if the user chose it and then confirmed", () => {
		const warning = { text: "w", action: "A", done: "D", run: () => {} };
		assert.equal(actionToRun(true, true, warning), warning.run);
		assert.equal(actionToRun(true, false, warning), undefined);
		// Cancel, Escape, closed or never shown
		assert.equal(actionToRun(false, true, warning), undefined);
		assert.equal(actionToRun(undefined, true, warning), undefined);
		assert.equal(actionToRun(true, true, undefined), undefined);
	});

	it("opens normalized http(s) links only", () => {
		assert.equal(httpLink("https://example.com/a b"), "https://example.com/a%20b");
		assert.equal(httpLink("https:example.com"), "https://example.com/");
		assert.equal(httpLink("javascript:alert(1)"), undefined);
		assert.equal(httpLink(" file:///C:/x"), undefined);
		assert.equal(httpLink(1), undefined);
	});
});
