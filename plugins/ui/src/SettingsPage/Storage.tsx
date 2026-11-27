import React from "react";

import Box from "@mui/material/Box";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import { debounce, Signal } from "@inrixia/helpers";
import { ftch, LunaPlugin, ReactiveStore } from "@luna/core";
import { StyleTag } from "@luna/lib";

import { Messager } from "@luna/core";
import type { LunaThemeStorage } from "./ThemesTab/LunaTheme";
import { parseThemeManifest, themeDisplay } from "./ThemesTab/themeManifest";
import { unloads } from "../index.safe";
import {
	findDuplicateTheme,
	maxThemeCssBytes,
	parseThemeUrl,
	revalidateThemes,
	startupUpdateMessage,
	storedThemeError,
	themeUrlError,
} from "./themesRefresh";
import { describeResources, parseThemeResources, resourceProblem, stylesheetProblem, themeConsent } from "./ThemesTab/themeResources";
import type { ThemeConsent } from "./ThemesTab/themeResources";
import { addToStores } from "./PluginStoreTab";
import { confirm } from "../helpers/confirm";

/**
 * What the last startup changed, kept after the toast is gone.
 *
 * TIDAL's toasts last about four seconds and there is no duration in the payload to lengthen, so a toast alone loses the
 * information: by the time the app has finished loading and you look at it, it is already dismissing. The tab shows this
 * instead, until it is dismissed.
 */
export const startupNotice = new Signal<string | undefined>(undefined);

const lunaStorage = ReactiveStore.getStore("@luna/storage");

export const themes = await lunaStorage.getReactive<Record<string, LunaThemeStorage>>("themes", {});
export type ThemeConsentFn = (consent: ThemeConsent) => Promise<boolean>;

export const addToThemes = async (rawUrl: string, askConsent?: ThemeConsentFn) => {
	// https only (loopback excepted), and the path must be a css file: a theme rewrites TIDAL's own page, so plain
	// http would let anyone on the network restyle it
	const invalid = themeUrlError(rawUrl.trim());
	if (invalid !== undefined) throw new Error(`Can't add that theme: ${invalid}`);
	const url = parseThemeUrl(rawUrl);
	if (url === undefined) return false;
	if (url in themes) return false;
	// The entry is added only once the theme is accepted: `themes` is persisted, and `enabled: true` is applied at the next
	// start, so creating it before asking installed the theme whatever the answer was. The StyleTag is created up front
	// only because the old code did; nothing is assigned to it until the theme is accepted.
	const styleTag = new StyleTag(url, unloads);

	let css: string;
	try {
		css = await ftch.text(url);
	} catch (e) {
		// The url did not serve anything, so there is nothing to keep: drop the entry and say so, rather than leaving a
		// row that silently does nothing and an install box that acts as if it worked
		styleTag.remove();
		throw new Error(`Could not load that url: ${e instanceof Error ? e.message : String(e)}`);
	}

	// Past this point the fetch worked, so a problem here is a refusal: drop what was created and let the caller say why,
	// otherwise the install box clears as if the theme had been added
	const refuse = (message: string) => {
		styleTag.remove();
		delete themeStyles[url];
		delete themes[url];
		throw new Error(message);
	};
	// Uncapped CSS is persisted to IndexedDB and re-applied on every start, so the limit has to be enforced here too
	if (css.length > maxThemeCssBytes) refuse(`That theme's CSS is ${css.length} bytes, over the ${maxThemeCssBytes} limit`);
	// A url that answers with a web page or json is not a theme: storing it would apply nothing and look like it worked
	const notCss = stylesheetProblem(css);
	if (notCss !== undefined) refuse(`That url ${notCss}`);
	// The same file is served at more than one url (with and without refs/heads), so the same theme could be added twice
	// and applied twice. Compare content, not urls.
	const duplicate = findDuplicateTheme(themes, url, css);
	if (duplicate !== undefined) refuse(`That theme is already installed as ${duplicate}`);

	// A theme is css, but it can name anything to fetch: the font pack installs thirteen binaries. Installing it is the
	// moment the user is still deciding, so ask before it is stored and applied. Without a handler to ask with, a theme
	// that downloads files is refused rather than installed unasked.
	const resources = parseThemeResources(css, url);
	const consent = themeConsent(url, resources);
	if (consent.required) {
		if (askConsent === undefined) {
			refuse("This theme downloads files, and there is no way to ask about that here");
			return false;
		}
		if (!(await askConsent(consent))) {
			refuse("Theme was not installed");
			return false;
		}
	}

	// Accepted: only now does the entry exist, with the css already in hand
	const theme = (themes[url] ??= { enabled: true });
	themeStyles[url] = styleTag;
	theme.css = css;
	styleTag.css = css;
	console.log("[Themes] Added and applied theme:", url);

	// What the theme loads and whether it is what it claims: a font url that serves an html page leaves the theme looking
	// broken for a reason nothing on screen explains. Reported rather than refused, since one bad file is not a reason to
	// throw away a theme that otherwise works.
	checkThemeResources(url, css).catch((e) => console.error("[Themes] Could not check what this theme loads:", e));
	return theme;
};

/**
 * HEAD every file a theme loads and log the ones that are not what the css says they are. Bounded: a theme that names
 * hundreds of files is not worth hundreds of requests at install time.
 */
export const checkThemeResources = async (url: string, css: string): Promise<void> => {
	const resources = parseThemeResources(css, url).filter((resource) => resource.absolute?.startsWith("http") ?? false);
	console.log(`[Themes] ${url} ${describeResources(resources) ?? "loads nothing"}`);
	for (const resource of resources.slice(0, 20)) {
		try {
			const res = await fetch(resource.absolute!, { method: "HEAD" });
			const problem = resourceProblem(resource, res.status, res.headers.get("content-type"));
			if (problem !== undefined) console.warn(`[Themes] ${resource.absolute} ${problem}`);
		} catch (e) {
			console.warn(`[Themes] Could not check ${resource.absolute}`, e);
		}
	}
};

// Apply enabled themes on startup
export const themeStyles: Record<string, StyleTag> = {};
for (const [url, theme] of Object.entries(themes)) {
	if (!theme.enabled) continue;
	// Stored themes can arrive from an imported backup or seed file, which never see the install box's url check
	const storedError = storedThemeError(url, theme);
	if (storedError !== undefined) {
		console.error(`[Themes] Not applying ${url}: ${storedError}`);
		continue;
	}
	console.log("[Themes] Applying theme on startup:", url);
	const styleTag = (themeStyles[url] = new StyleTag(url, unloads));
	if (theme.css) {
		styleTag.css = theme.css;
	} else {
		ftch
			.text(url)
			.then((css) => {
				theme.css = css;
				styleTag.css = css;
			})
			.catch((e) => {
				// An enabled theme with nothing applied is worse than a disabled one: the switch says it is on and the page
				// looks unchanged, with no way to tell why. Turn it off so the state matches what is on screen.
				console.error("[Themes] Failed to load theme:", url, e);
				theme.enabled = false;
				styleTag.remove();
				delete themeStyles[url];
			});
	}
}

// The stored CSS above is applied without asking the server, which is why a theme used to stay stale until it was
// refreshed by hand and then disabled and re-enabled (or reloaded one by one, which hurt themes shipped as several
// packages: a base, a second part, fonts, addons). Revalidate all enabled themes once now, in the background, so the
// page is styled immediately and only the themes that changed upstream get restyled.
revalidateThemes(themes, themeStyles, {
	// Raw fetch, not ftch.text: a 304 means "unchanged", and ftch throws on any non-ok status. The adapter narrows
	// Response to the four things the refresh reads, so this stays testable without a Response object
	fetch: async (url, init) => {
		const res = await fetch(url, init);
		return {
			status: res.status,
			ok: res.ok,
			text: () => res.text(),
			headers: { get: (name: string) => res.headers.get(name) },
		};
	},
	log: console.log,
	error: console.error,
})
	.then((summary) => {
		// Say it happened: the CSS is swapped in while TIDAL is starting, so colours and spacing change with nothing on
		// screen to explain why. The names come from the url, since the css has not been parsed into a manifest yet.
		// The name the row would show: the manifest's, when the css has one, since that is what the user sees in the tab
		const message = startupUpdateMessage(summary, (url) => themeDisplay(url, parseThemeManifest(themes[url]?.css)).name);
		if (message !== undefined) {
			startupNotice._ = message;
			// Wait for TIDAL's own shell: shown during startup the toast is gone in four seconds, before the app is even
			// usable, so nobody sees it. Once the shell is up it lands on the page the user is actually looking at.
			void whenAppReady().then(() => Messager.Info(message));
		}
		if (summary.failed.length > 0) console.error(`[Themes] ${summary.failed.length} theme(s) could not be checked at startup`);
	})
	.catch((e) => console.error("[Themes] Startup theme refresh failed", e));

// Emergency shortcut to disable all themes (Ctrl+Shift+T)
const onEmergencyDisable = (event: KeyboardEvent) => {
	if (event.ctrlKey && event.shiftKey && event.key === "T") {
		let disabled = 0;
		for (const [url, styleTag] of Object.entries(themeStyles)) {
			if (!themes[url]?.enabled) continue;
			styleTag.css = undefined;
			themes[url].enabled = false;
			disabled++;
		}
		if (disabled > 0) console.log(`[Themes] Emergency disable: disabled ${disabled} theme(s)`);
	}
};
document.addEventListener("keydown", onEmergencyDisable);
unloads.add(() => document.removeEventListener("keydown", onEmergencyDisable));

const successSx = {
	"& .MuiOutlinedInput-root:hover:not(.Mui-focused) .MuiOutlinedInput-notchedOutline": {
		borderColor: "success.main", // Or a slightly different shade if desired
	},
	"& .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline": {
		borderColor: "success.main",
	},
	"& .MuiInputLabel-root.Mui-focused": {
		color: "success.main",
	},
	"& .MuiOutlinedInput-root .MuiOutlinedInput-notchedOutline": {
		borderColor: "success.main",
	},
	"& .MuiInputLabel-root": {
		color: "success.main",
	},
};

export const InstallFromUrl = React.memo(() => {
	const [success, setSuccess] = React.useState<string | null>(null);
	const [err, setErr] = React.useState<string | null>(null);
	const [value, setValue] = React.useState<string>("");

	// Define the core logic for loading the plugin
	const loadPlugin = React.useCallback(async (urlValue: string) => {
		if (urlValue === "") return;
		try {
			// Sanity check url
			const url = new URL(urlValue).href;
			let successMessage;
			if (url.endsWith("/store.json")) {
				if (addToStores(url) === false) return setErr("Store already added");
				successMessage = `Added store ${url}!`;
			} else if (url.endsWith(".css")) {
				// Ask before a theme that pulls in other files: the count and hosts, with the dialog the app already uses
				if (
					(await addToThemes(url, async (consent) => {
						const { confirmed } = await confirm({
							title: consent.title,
							// What and where, not just how many: the host groups name each file
							description: (
								<>
									{consent.description}
									{consent.hosts.map((host) => (
										<Box key={host.host} sx={{ marginTop: 1.5 }}>
											{/* Host then its files: caption size and a faded colour made the list unreadable on a light dialog */}
											<Typography
												variant="body2"
												sx={{ fontWeight: "600 !important", lineHeight: 1.5, fontSize: "1rem !important" }}
												children={host.host}
											/>
											{host.files.map((file) => (
												<Typography
													key={file.url}
													variant="body2"
													title={file.url}
													sx={{ display: "block", lineHeight: 1.5, paddingLeft: 2, fontSize: "0.95rem !important", wordBreak: "break-all" }}
													children={file.label}
												/>
											))}
											{host.hidden > 0 && (
												<Typography variant="body2" sx={{ display: "block", lineHeight: 1.5, paddingLeft: 2, fontSize: "0.95rem !important" }}>
													and {host.hidden} more from {host.host}
												</Typography>
											)}
										</Box>
									))}
								</>
							),
							confirmationText: consent.confirmationText,
						});
						return confirmed;
					})) === false
				)
					return setErr("Theme already added");
				successMessage = `Added theme ${url}!`;
			} else {
				const plugin = await LunaPlugin.fromStorage({ url });
				successMessage = `Loaded plugin ${plugin.name}!`;
			}
			setValue(""); // Reset input on success
			setErr(null);
			setSuccess(successMessage);
			// TODO: Clean up this mess
			Messager.Info(successMessage);
			// Clear success message after a delay
			setTimeout(() => setSuccess(null), 2000);
		} catch (e: any) {
			setErr(e.message ?? "Invalid URL or failed to load plugin");
			setSuccess(null); // Clear success on error
		}
	}, []); // Dependencies: none, as it uses the passed urlValue

	// Create a stable debounced function using useMemo
	const debouncedLoad = React.useMemo(
		() => debounce(loadPlugin, 500),
		[loadPlugin], // Recreate debounce if loadPlugin changes (it shouldn't due to useCallback)
	);

	const onInput = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
		if (event.target.value === "") setErr(null);
		setValue(event.target.value);
		debouncedLoad(event.target.value);
	}, []);

	return (
		<TextField
			sx={success !== null ? successSx : null}
			error={err !== null}
			variant="outlined"
			size="small"
			fullWidth
			value={value}
			label={err ?? success ?? "Install from URL"}
			onChange={onInput}
		/>
	);
});

/**
 * Resolve once TIDAL has painted its own interface, or after a cap.
 *
 * The cap matters: if the shell never appears (a failed load, an update) the toast should still be shown rather than
 * being swallowed by a promise that never settles.
 */
export const whenAppReady = (maxMs = 8000): Promise<void> =>
	new Promise((resolve) => {
		const started = Date.now();
		const check = () => {
			// TIDAL's shell is the sidebar plus real page content. The sidebar alone appears while the page is still a
			// blank outline, and a toast shown then lands on an empty window and is gone before the content paints.
			const hasShell = document.querySelector('nav, [class*="sidebar"]') !== null;
			const hasContent = (document.querySelector("main")?.innerText ?? "").trim().length > 200;
			if ((hasShell && hasContent) || Date.now() - started >= maxMs) {
				resolve();
				return;
			}
			setTimeout(check, 200);
		};
		check();
	});
