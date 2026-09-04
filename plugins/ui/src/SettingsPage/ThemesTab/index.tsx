import React from "react";

import Stack from "@mui/material/Stack";

import { store as obyStore } from "oby";

import { LunaGroup, LunaRow, LunaSection } from "../../components/LunaList";
import { metrics, wave } from "../../tidalTokens";
import { InstallFromUrl, themes, themeStyles } from "../Storage";
import { LunaTheme } from "./LunaTheme";

export const ThemesTab = React.memo(() => {
	const [_themes, setThemes] = React.useState(() => ({ ...obyStore.unwrap(themes) }));
	React.useEffect(() => {
		obyStore.on(themes, () => setThemes({ ...obyStore.unwrap(themes) }));
	}, []);

	const entries = Object.entries(_themes);

	return (
		<Stack spacing={3} sx={{ fontFamily: wave.font, maxWidth: metrics.maxTextW }}>
			<LunaSection title={`Themes${entries.length ? ` (${entries.length})` : ""}`}>
				<LunaGroup>
					{entries.length === 0 ? (
						<LunaRow title="No themes installed" desc="Paste a link to a .css theme below." />
					) : (
						entries.map(([url, theme]) => (
							<LunaTheme
								theme={theme}
								key={url}
								url={url}
								uninstall={() => {
									if (themeStyles[url]) {
										themeStyles[url].remove();
										delete themeStyles[url];
									}
									delete themes[url];
								}}
							/>
						))
					)}
				</LunaGroup>
			</LunaSection>

			<LunaSection title="Add a theme" desc="Paste a link to a .css theme, a plugin, or a store.">
				<InstallFromUrl />
			</LunaSection>
		</Stack>
	);
});
