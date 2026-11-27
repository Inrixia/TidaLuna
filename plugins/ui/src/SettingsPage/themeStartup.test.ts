import { describe, expect, it, vi } from "vitest";

import { applyThemeOnStartup } from "./themeStartup";

const url = "https://example.com/theme.css";

describe("applyThemeOnStartup", () => {
	it("applies the saved CSS before the fetch finishes", async () => {
		const theme = { enabled: true, css: "saved" };
		const style: { css?: string } = {};
		let finish!: (css: string) => void;
		const pending = applyThemeOnStartup(
			url,
			theme,
			style,
			() => new Promise<string>((r) => (finish = r)),
			() => true,
		);
		expect(style.css).toBe("saved");
		finish("saved");
		await pending;
		expect(style.css).toBe("saved");
	});

	it("saves and applies newer CSS from the url", async () => {
		const theme = { enabled: true, css: "old" };
		const style: { css?: string } = {};
		await applyThemeOnStartup(
			url,
			theme,
			style,
			async () => "new",
			() => true,
		);
		expect(theme.css).toBe("new");
		expect(style.css).toBe("new");
	});

	it("fetches a theme that has no saved CSS yet", async () => {
		const theme: { enabled: boolean; css?: string } = { enabled: true };
		const style: { css?: string } = {};
		await applyThemeOnStartup(
			url,
			theme,
			style,
			async () => "first",
			() => true,
		);
		expect(theme.css).toBe("first");
		expect(style.css).toBe("first");
	});

	it("keeps the saved CSS and only logs when the fetch fails", async () => {
		const theme = { enabled: true, css: "saved" };
		const style: { css?: string } = {};
		const onError = vi.fn();
		const err = new Error("offline");
		await applyThemeOnStartup(
			url,
			theme,
			style,
			async () => Promise.reject(err),
			() => true,
			onError,
		);
		expect(theme.css).toBe("saved");
		expect(style.css).toBe("saved");
		expect(onError).toHaveBeenCalledWith(expect.stringContaining("Failed to update theme"), url, err);
	});

	it("keeps the saved CSS when the url answers with nothing", async () => {
		const theme = { enabled: true, css: "saved" };
		const style: { css?: string } = {};
		await applyThemeOnStartup(
			url,
			theme,
			style,
			async () => " ",
			() => true,
		);
		expect(theme.css).toBe("saved");
		expect(style.css).toBe("saved");
	});

	it("leaves a theme disabled meanwhile alone", async () => {
		const theme = { enabled: true, css: "old" };
		const style: { css?: string } = {};
		let enabled = true;
		const pending = applyThemeOnStartup(
			url,
			theme,
			style,
			async () => {
				enabled = false;
				return "new";
			},
			() => enabled,
		);
		await pending;
		expect(theme.css).toBe("old");
		expect(style.css).toBe("old");
	});

	it("does not touch anything when the CSS is unchanged", async () => {
		const theme = { enabled: true, css: "same" };
		const style = { css: undefined as string | undefined };
		const set = vi.fn();
		Object.defineProperty(style, "css", { get: () => "same", set });
		await applyThemeOnStartup(
			url,
			theme,
			style,
			async () => "same",
			() => true,
		);
		expect(set).toHaveBeenCalledTimes(1); // only the saved CSS applied first
	});
});
