import React from "react";

import TextField from "@mui/material/TextField";

import { debounce } from "@inrixia/helpers";
import { LunaPlugin, Messager } from "@luna/core";
import { safeTimeout } from "@luna/lib";

import { unloads } from "../index.safe";
import { addToStores } from "./PluginStoreTab";
import { confirmThemeConsent } from "./ThemeConsentPrompt";
import { LunaTheme } from "./ThemesTab/LunaTheme";
import { themes } from "./ThemesTab/themes";

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

/**
 * The one install box.
 *
 * A url is a store, a theme or a plugin, and it used to be three near-identical boxes with their own copy of this
 * component, the same debounce and the same text field: pasting a theme url into the plugin store did nothing, and the
 * copies drifted. One box that reads what it was given installs all three.
 */
export const InstallFromUrl = React.memo(() => {
	const [success, setSuccess] = React.useState<string | null>(null);
	const [err, setErr] = React.useState<string | null>(null);
	const [value, setValue] = React.useState<string>("");

	// Define the core logic for loading the plugin
	const loadFromUrl = React.useCallback(async (urlValue: string) => {
		if (urlValue === "") return;
		try {
			// Sanity check url
			const url = new URL(urlValue).href;
			let successMessage;
			if (url.endsWith("/store.json")) {
				if (addToStores(url) === false) return setErr("Store already added");
				successMessage = `Added store ${url}!`;
			} else if (url.endsWith(".css")) {
				const theme = await LunaTheme.install(url, unloads, confirmThemeConsent);
				// Stored only once the theme exists, so a refused install leaves nothing behind
				themes[theme.url] = theme.data;
				successMessage = `Added theme ${theme.manifest.name}!`;
			} else {
				const plugin = await LunaPlugin.fromStorage({ url });
				if (!plugin.installed) await plugin.install();
				successMessage = `Loaded plugin ${plugin.name}!`;
			}
			setValue(""); // Reset input on success
			setErr(null);
			setSuccess(successMessage);
			Messager.Info(successMessage);
			// Clear the success message after a delay, tied to the plugin so it cannot fire into an unloaded page
			safeTimeout(unloads, () => setSuccess(null), 2000);
		} catch (e) {
			setErr(e instanceof Error ? e.message : "Invalid URL or failed to load plugin");
			setSuccess(null); // Clear success on error
		}
	}, []); // Dependencies: none, as it uses the passed urlValue

	// Create a stable debounced function using useMemo
	const debouncedLoad = React.useMemo(
		() => debounce(loadFromUrl, 500),
		[loadFromUrl], // Recreate debounce if loadFromUrl changes (it shouldn't due to useCallback)
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
