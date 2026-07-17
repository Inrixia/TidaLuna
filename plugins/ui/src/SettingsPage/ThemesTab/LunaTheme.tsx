import React from "react";

import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";

import { LunaSwitch, LunaTrashButton, SpinningButton } from "../../components";

import type { VoidFn } from "@inrixia/helpers";
import { ftch } from "@luna/core";
import { StyleTag } from "@luna/lib";
import { unloads } from "../../index.safe";
import { LunaPluginHeader } from "../PluginsTab/LunaPluginHeader";
import { themes, themeStyles } from "../Storage";

export type LunaThemeStorage = {
	enabled: boolean;
	css?: string;
};

export const LunaTheme = React.memo(({ theme, url, uninstall }: { theme: LunaThemeStorage; url: string; uninstall: VoidFn }) => {
	const [enabled, setEnabled] = React.useState(theme.enabled);
	// Sync enabled state when prop changes (e.g., emergency disable shortcut)
	React.useEffect(() => setEnabled(theme.enabled), [theme.enabled]);
	const [css, setCSS] = React.useState(theme.css);
	const [loading, setLoading] = React.useState(false);
	const [themeStyle] = React.useState(() => themeStyles[url] ?? (themeStyles[url] = new StyleTag(url, unloads)));
	// Neptune theme manifest support
	const [manifest, setManifest] = React.useState<{ name?: string; description?: string; author?: string } | undefined>();

	const toggleEnabled = React.useCallback((_: unknown, checked: boolean) => {
		setEnabled((themes[url].enabled = checked));
		themeStyle.css = checked ? themes[url].css : undefined;
	}, []);
	const loadCSS = React.useCallback(async () => {
		setLoading(true);
		try {
			const css = (themes[url].css = await ftch.text(url));
			setCSS(css);
			setManifest(JSON.parse(css.slice(css.indexOf("/*") + 2, css.indexOf("*/"))));
		} finally {
			setLoading(false);
		}
	}, []);

	React.useEffect(() => {
		if (themes[url]?.enabled) {
			if (css === undefined) loadCSS();
			else themeStyle.css = css;
		}
	}, []);

	return (
		<Stack
			spacing={1}
			sx={{
				borderRadius: 3,
				backgroundColor: "rgba(0, 0, 0, 0.10)",
				padding: 2,
				paddingTop: 1,
				paddingBottom: 1,
			}}
		>
			<LunaPluginHeader
				name={manifest?.name ?? url}
				desc={manifest?.description}
				author={manifest?.author}
				link={url}
				children={
					<>
						<Tooltip
							title={enabled ? `Disable ${name}` : `Enable ${name}`}
							children={<LunaSwitch checked={enabled} loading={loading} onChange={toggleEnabled} />}
						/>
						<SpinningButton title="Reload theme" spin={loading} disabled={loading} onClick={loadCSS} />
						<LunaTrashButton title="Uninstall plugin" onClick={uninstall} />
					</>
				}
			/>
		</Stack>
	);
});
