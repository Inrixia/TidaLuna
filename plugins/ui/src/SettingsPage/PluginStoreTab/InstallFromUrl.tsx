import React from "react";

import TextField from "@mui/material/TextField";

import { debounce } from "@inrixia/helpers";
import { LunaPlugin } from "@luna/core";

import { Messager } from "@luna/core";
import { addToStores } from "./storeState";
import { installPluginWithLibraries } from "./pluginInstall";

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
			} else {
				const plugin = await LunaPlugin.fromStorage({ url });
				if (!(await installPluginWithLibraries(plugin))) return;
				successMessage = `Installed plugin ${plugin.name}!`;
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
