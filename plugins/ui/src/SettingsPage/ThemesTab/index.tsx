import React from "react";

import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { InstallFromUrl, themes, themeStyles } from "../Storage";
import { LunaTheme } from "./LunaTheme";

import { store as obyStore } from "oby";

/** One sentence for someone who has never met a theme, kept under the rows so it does not crowd them */
const explainer =
	"A theme is a CSS file loaded from a url. Turn one on and it restyles TIDAL everywhere; Reload re-reads the file after it changes, and installed themes are checked again when TIDAL starts.";

export const ThemesTab = React.memo(() => {
	const [_themes, setThemes] = React.useState(() => ({ ...obyStore.unwrap(themes) }));
	// Return the disposer so closing the tab stops listening
	React.useEffect(() => obyStore.on(themes, () => setThemes({ ...obyStore.unwrap(themes) })), []);

	const entries = Object.entries(_themes);
	// The noun matters: "1 of 2 on" never said of what. This says how many are installed and calls out the ones that
	// have no stylesheet yet, which is the state the switches cannot show.
	const unloaded = entries.filter(([, theme]) => theme.enabled && theme.css === undefined).length;
	const summary =
		entries.length === 0
			? "No themes installed yet"
			: `${entries.length} ${entries.length === 1 ? "theme" : "themes"} installed${unloaded > 0 ? `, ${unloaded} still loading` : ""}`;

	return (
		<Stack spacing={2}>
			<InstallFromUrl />
			<Typography variant="caption" sx={{ color: "inherit" }} children={summary} />
			{entries.map(([url, theme]) => (
				<LunaTheme
					theme={theme}
					key={url}
					url={url}
					uninstall={() => {
						// Remove StyleTag
						if (themeStyles[url]) {
							themeStyles[url].remove();
							delete themeStyles[url];
						}
						// Remove from reactive store
						delete themes[url];
					}}
				/>
			))}
			<Box
				sx={{
					borderLeft: "3px solid rgba(255, 255, 255, 0.25)",
					paddingLeft: 2,
					marginTop: 1,
				}}
			>
				<Typography variant="body2" sx={{ color: "inherit" }} children={explainer} />
			</Box>
		</Stack>
	);
});
