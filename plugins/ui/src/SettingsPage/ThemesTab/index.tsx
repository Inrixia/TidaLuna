import React from "react";

import Stack from "@mui/material/Stack";

import { InstallFromUrl, themes } from "../Storage";
import { LunaTheme } from "./LunaTheme";

import { store as obyStore } from "oby";

export const ThemesTab = React.memo(() => {
	const [_themes, setThemes] = React.useState(themes);
	React.useEffect(() => {
		obyStore.on(themes, () => setThemes(obyStore.unwrap(themes)));
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
						delete _themes[url];
					}}
				/>
			))}
		</Stack>
	);
});
