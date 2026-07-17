import React from "react";

import TextField from "@mui/material/TextField";

import { debounce } from "@inrixia/helpers";
import { ftch, LunaPlugin, ReactiveStore } from "@luna/core";
import { StyleTag } from "@luna/lib";

import { Messager } from "@luna/core";
import type { LunaThemeStorage } from "./ThemesTab/LunaTheme";
import { unloads } from "../index.safe";

const lunaStorage = ReactiveStore.getStore("@luna/storage");
export const storeUrls = await lunaStorage.getReactive<string[]>("storeUrls", []);
export const addToStores = (url: string) => {
	if (url.endsWith("/store.json")) url = url.slice(0, -11);
	if (storeUrls.includes(url)) return false;
	return storeUrls.push(url);
};

export const themes = await lunaStorage.getReactive<Record<string, LunaThemeStorage>>("themes", {});
export const addToThemes = async (url: string) => {
	if (url in themes) return false;
	const theme = (themes[url] ??= { enabled: true });
	// Create StyleTag and load CSS immediately
	const styleTag = (themeStyles[url] = new StyleTag(url, unloads));
	try {
		const css = await ftch.text(url);
		theme.css = css;
		styleTag.css = css;
		console.log("[Themes] Added and applied theme:", url);
	} catch (e) {
		console.error("[Themes] Failed to load theme:", url, e);
	}
	return theme;
};

// Apply enabled themes on startup
export const themeStyles: Record<string, StyleTag> = {};
for (const [url, theme] of Object.entries(themes)) {
	if (!theme.enabled) continue;
	console.log("[Themes] Applying theme on startup:", url);
	const styleTag = (themeStyles[url] = new StyleTag(url, unloads));
	if (theme.css) {
		styleTag.css = theme.css;
	} else {
		ftch.text(url).then((css) => {
			theme.css = css;
			styleTag.css = css;
		}).catch((e) => console.error("[Themes] Failed to load theme:", url, e));
	}
}

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
				if ((await addToThemes(url)) === false) return setErr("Theme already added");
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
			onInput={onInput}
		/>
	);
});
