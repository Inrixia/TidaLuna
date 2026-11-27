export type ThemeEntry = { enabled: boolean; css?: string };
export type ThemeStyle = { css?: string };

/**
 * Applies an enabled theme when Luna starts. The saved CSS goes on the page at once, so a slow or failing network never
 * leaves the page unstyled; the theme's url is then fetched in the background and, if the CSS changed and the theme is
 * still enabled by then and is not empty, the new CSS is saved and applied. A failed fetch is only logged: what is saved stays.
 */
export const applyThemeOnStartup = async (
	url: string,
	theme: ThemeEntry,
	style: ThemeStyle,
	fetchText: (url: string) => Promise<string>,
	stillEnabled: () => boolean,
	onError: (message: string, url: string, e: unknown) => void = console.error,
) => {
	if (theme.css !== undefined) style.css = theme.css;
	try {
		const css = await fetchText(url);
		// An empty answer (a proxy, an outage page cut short) is no theme: the saved CSS stays
		if (!stillEnabled() || css.trim() === "" || css === theme.css) return;
		theme.css = css;
		style.css = css;
	} catch (e) {
		onError("[Themes] Failed to update theme on startup:", url, e);
	}
};
