import { describe, expect, it } from "vitest";

import {
	actionToRun,
	ANSWER_IN_USE_MS,
	buildConfirmHtml,
	CANCEL_GAP_MS,
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
		expect(gate.refuse({ tidal: AWAY, now: 0 })).toBe("TIDAL is not in use");
		expect(gate.pending).toBe(0);
	});

	it("takes recent input in TIDAL when focus isn't reported, but never a hidden TIDAL", () => {
		const gate = confirmGate();
		expect(gate.refuse({ tidal: { ...AWAY, recentUserInput: true }, now: 0 })).toBe(undefined);
		expect(gate.refuse({ tidal: { visible: false, focused: true, recentUserInput: true }, now: 0 })).toBe("TIDAL is not in use");
	});

	it("takes an answer in a confirmation window as using TIDAL for a while", () => {
		const gate = confirmGate();
		expect(gate.refuse({ tidal: FOCUSED, now: 0 })).toBe(undefined);
		gate.answered(true, 100);
		expect(gate.refuse({ tidal: AWAY, now: 100 + ANSWER_IN_USE_MS - 1 })).toBe(undefined);
		gate.answered(false, 200);
		expect(gate.refuse({ tidal: AWAY, now: 200 + ANSWER_IN_USE_MS })).toBe("TIDAL is not in use");
		// A window that was never shown is not an answer
		expect(gate.refuse({ tidal: FOCUSED, now: 300 })).toBe(undefined);
		gate.answered(undefined, 300);
		expect(gate.refuse({ tidal: AWAY, now: 200 + ANSWER_IN_USE_MS })).toBe("TIDAL is not in use");
	});

	it("stops taking the answer once the user leaves TIDAL", () => {
		const gate = confirmGate();
		expect(gate.refuse({ tidal: FOCUSED, now: 0 })).toBe(undefined);
		gate.answered(false, 0);
		gate.left();
		expect(gate.refuse({ tidal: AWAY, now: 1 })).toBe("TIDAL is not in use");
	});

	it("lets only a few wait at once", () => {
		const gate = confirmGate();
		for (let i = 0; i < MAX_PENDING; i++) expect(gate.refuse({ tidal: FOCUSED, now: 0 })).toBe(undefined);
		expect(gate.refuse({ tidal: FOCUSED, now: 0 })!).toMatch(/already waiting/);
		gate.answered(true, 0);
		expect(gate.refuse({ tidal: FOCUSED, now: 0 })).toBe(undefined);
	});

	it("cools down after cancels in a row, an accept resets", () => {
		const gate = confirmGate();
		const ask = (now: number) => gate.refuse({ tidal: FOCUSED, now });
		for (let i = 0; i < MAX_CANCELS - 1; i++) {
			expect(ask(i)).toBe(undefined);
			gate.answered(false, i);
		}
		expect(ask(10)).toBe(undefined);
		gate.answered(true, 10);
		for (let i = 0; i < MAX_CANCELS; i++) {
			expect(ask(20 + i)).toBe(undefined);
			gate.answered(false, 20 + i);
		}
		expect(ask(100)!).toMatch(/cancelled in a row/);
		expect(ask(20 + MAX_CANCELS + COOL_DOWN_MS)).toBe(undefined);
	});

	it("doesn't let an unpaired answered() raise the limit", () => {
		const gate = confirmGate();
		gate.answered(true, 0);
		gate.answered(true, 0);
		expect(gate.pending).toBe(0);
		for (let i = 0; i < MAX_PENDING; i++) expect(gate.refuse({ tidal: FOCUSED, now: 0 })).toBe(undefined);
		expect(gate.refuse({ tidal: FOCUSED, now: 0 })!).toMatch(/already waiting/);
	});

	it("counts only cancels close together as in a row", () => {
		const cancels = (gapMs: number) => {
			const gate = confirmGate();
			let now = 0;
			for (let i = 0; i < MAX_CANCELS; i++) {
				expect(gate.refuse({ tidal: FOCUSED, now })).toBe(undefined);
				gate.answered(false, now);
				now += gapMs;
			}
			return gate.refuse({ tidal: FOCUSED, now });
		};
		// The user's own cancels, a bit apart (the old threshold was the whole cool-down: 45 s apart tripped it)
		expect(cancels(CANCEL_GAP_MS + 1)).toBe(undefined);
		expect(cancels(45_000)).toBe(undefined);
		expect(cancels(CANCEL_GAP_MS)!).toMatch(/cancelled in a row/);
		expect(cancels(1_000)!).toMatch(/cancelled in a row/);
	});

	it("doesn't count windows that were never shown", () => {
		const gate = confirmGate();
		for (let i = 0; i < MAX_CANCELS * 2; i++) {
			expect(gate.refuse({ tidal: FOCUSED, now: i })).toBe(undefined);
			gate.answered(undefined, i);
		}
		expect(gate.pending).toBe(0);
	});

	it("doesn't count cancels long apart", () => {
		const gate = confirmGate();
		for (let i = 0; i < MAX_CANCELS * 2; i++) {
			const now = i * (COOL_DOWN_MS + 1);
			expect(gate.refuse({ tidal: FOCUSED, now })).toBe(undefined);
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
		expect(html.includes("<img src=x")).toBe(false);
		expect(html.includes("<script>x()")).toBe(false);
		expect(html.includes("<b>Go</b>")).toBe(false);
		expect(html.includes("&lt;img src=x onerror=alert(1)&gt;")).toBe(true);
	});

	it("starts with the confirm button disabled and Cancel focused", () => {
		const html = buildConfirmHtml({ title: "T", lines: [], confirmText: "Install" });
		// Armed by the window (data-arm, see NativeConfirm), Cancel never is
		expect(html).toMatch(/<button id="confirm" data-arm disabled>Install<\/button>/);
		expect(html).toMatch(/<button id="cancel">Cancel<\/button>/);
		expect(html).toMatch(/getElementById\("cancel"\)\.focus\(\)/);
	});

	it("checks requests that come over IPC", () => {
		expect(confirmRequest("T", ["a"], "Go")).toEqual({ title: "T", lines: ["a"], confirmText: "Go" });
		expect(() => confirmRequest(1, [], "Go")).toThrow();
		expect(() => confirmRequest("T", "a", "Go")).toThrow();
		expect(() => confirmRequest("T", [{}], "Go")).toThrow();
		expect(() => confirmRequest("", [], "Go")).toThrow();
		expect(() => confirmRequest("T", new Array(13).fill("a"), "Go")).toThrow();
		expect(confirmRequest("x".repeat(700), [], "Go").title.length).toBe(601);
	});

	it("takes http(s) links only, and a warning only with an action to run", () => {
		const link = { text: "v2", href: "https://example.com/owner/repo/commit/abc1234" };
		expect(confirmRequest("T", [["a ", link]], "Go").lines).toStrictEqual([["a ", link]]);
		expect(() => confirmRequest("T", [[{ text: "x", href: "javascript:alert(1)" }]], "Go")).toThrow();
		expect(() => confirmRequest("T", [[{ text: "x", href: "file:///C:/x" }]], "Go")).toThrow();
		expect(() => confirmRequest("T", [[{ text: "x" }]], "Go")).toThrow();
		expect(() => confirmRequest("T", [[1]], "Go")).toThrow();
		const run = () => {};
		expect(shownWarning(confirmRequest("T", [], "Go", { text: "w", action: "Ask again", done: "d", run }))?.run).toBe(run);
		expect(() => confirmRequest("T", [], "Go", { text: "w", action: "Ask again", done: "d" })).toThrow();
		expect(() => confirmRequest("T", [], "Go", { text: 1, action: "Ask again", done: "d", run })).toThrow();
	});

	it("numbers its links in the order main opens them, and escapes them", () => {
		const request = confirmRequest(
			"T",
			["plain", ["a ", { text: "<b>one</b>", href: "https://a.example/1?x=1&y=2" }], [{ text: "two", href: "http://b.example" }]],
			"Go",
		);
		// Normalized: b.example's path gets its slash
		expect(confirmLinks(request)).toStrictEqual(["https://a.example/1?x=1&y=2", "http://b.example/"]);
		const html = buildConfirmHtml({ ...request, warning: shownWarning(request) });
		expect(html).toMatch(/<a href="#" data-link="0" title="https:\/\/a\.example\/1\?x=1&amp;y=2">&lt;b&gt;one&lt;\/b&gt;<\/a>/);
		expect(html).toMatch(/<a href="#" data-link="1" title="http:\/\/b\.example\/">two<\/a>/);
		expect(html.includes("<b>one</b>")).toBe(false);
	});

	it("shows a warning with its own button only when there is one", () => {
		const warning = { text: "<i>Allowed</i>", action: "Ask again", done: "Asks again", run: () => {} };
		const html = buildConfirmHtml({ title: "T", lines: [], confirmText: "Go", warning });
		expect(html).toMatch(/<span id="warning-text">&lt;i&gt;Allowed&lt;\/i&gt;<\/span><button id="warning-action">Ask again<\/button>/);
		expect(buildConfirmHtml({ title: "T", lines: [], confirmText: "Go" }).includes('id="warning-text"')).toBe(false);
	});

	it("takes a warning given as a function when the window shows, and checks it then", () => {
		let state: string | undefined;
		const request = confirmRequest("T", [], "Go", () =>
			state === undefined ? undefined : { text: state, action: "A", done: "D", run: () => {} },
		);
		expect(shownWarning(request)).toBe(undefined);
		state = "now";
		expect(shownWarning(request)?.text).toBe("now");
		const bad = confirmRequest("T", [], "Go", () => ({ text: "w", action: "A", done: "D" }));
		expect(() => shownWarning(bad)).toThrow();
	});

	it("runs the warning's action only if the user chose it and then confirmed", () => {
		const warning = { text: "w", action: "A", done: "D", run: () => {} };
		expect(actionToRun(true, true, warning)).toBe(warning.run);
		expect(actionToRun(true, false, warning)).toBe(undefined);
		// Cancel, Escape, closed or never shown
		expect(actionToRun(false, true, warning)).toBe(undefined);
		expect(actionToRun(undefined, true, warning)).toBe(undefined);
		expect(actionToRun(true, true, undefined)).toBe(undefined);
	});

	it("opens normalized http(s) links only", () => {
		expect(httpLink("https://example.com/a b")).toBe("https://example.com/a%20b");
		expect(httpLink("https:example.com")).toBe("https://example.com/");
		expect(httpLink("javascript:alert(1)")).toBe(undefined);
		expect(httpLink(" file:///C:/x")).toBe(undefined);
		expect(httpLink(1)).toBe(undefined);
	});
});
