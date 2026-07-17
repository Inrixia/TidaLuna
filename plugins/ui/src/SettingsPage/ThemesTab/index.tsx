import React from "react";

import Stack from "@mui/material/Stack";

import { InstallFromUrl, themes, themeStyles } from "../Storage";
import { LunaTheme } from "./LunaTheme";

import { store as obyStore } from "oby";

export const ThemesTab = React.memo(() => {
	const [_themes, setThemes] = React.useState(() => ({ ...obyStore.unwrap(themes) }));
	React.useEffect(() => {
		obyStore.on(themes, () => setThemes({ ...obyStore.unwrap(themes) }));
	}, []);
	return (
		<Stack spacing={2}>
			<InstallFromUrl />
			{Object.entries(_themes).map(([url, theme]) => (
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
		</Stack>
	);
});
