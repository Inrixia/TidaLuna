import React from "react";

import Box from "@mui/material/Box";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import { debounce } from "@inrixia/helpers";
import { LunaPlugin, Messager } from "@luna/core";

import { confirm } from "../helpers/confirm";
import { unloads } from "../index.safe";
import { Theme } from "./ThemesTab/Theme";
import type { ThemeConsent } from "./ThemesTab/ThemeResources";
import { themes } from "./ThemesTab/themes";
import { addToStores } from "./PluginStoreTab";

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
 * Ask before installing a theme that downloads files of its own, naming the files and the hosts rather than counting them.
 *
 * The dialog is the one the app already uses, so the answer is a familiar confirm rather than a new kind of prompt.
 */
const confirmThemeConsent = async (consent: ThemeConsent) => {
	const { confirmed } = await confirm({
		title: consent.title,
		// What and where, not just how many: the host groups name each file
		description: (
			<>
				{consent.description}
				{consent.hosts.map((host) => (
					<Box key={host.host} sx={{ marginTop: 1.5 }}>
						{/* Host then its files: caption size and a faded colour made the list unreadable on a light dialog */}
						<Typography variant="body2" sx={{ fontWeight: "600 !important", lineHeight: 1.5, fontSize: "1rem !important" }} children={host.host} />
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
				const theme = await Theme.install(url, themes, unloads, confirmThemeConsent);
				successMessage = `Added theme ${theme.manifest.name}!`;
			} else {
				const plugin = await LunaPlugin.fromStorage({ url });
				if (!plugin.installed) await plugin.install();
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
