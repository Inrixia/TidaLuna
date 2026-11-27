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
import { allowSource, reloadToRead } from "../allowSource";

export type LunaThemeStorage = {
	enabled: boolean;
	css?: string;
};

type LunaThemeManifest = { name?: string; description?: string; author?: string };
// Neptune themes can start with a JSON manifest in a comment, most themes have none
const parseManifest = (css?: string): LunaThemeManifest | undefined => {
	if (css === undefined) return undefined;
	try {
		return JSON.parse(css.slice(css.indexOf("/*") + 2, css.indexOf("*/")));
	} catch {
		return undefined;
	}
};

export const LunaTheme = React.memo(({ theme, url, uninstall }: { theme: LunaThemeStorage; url: string; uninstall: VoidFn }) => {
	const [enabled, setEnabled] = React.useState(theme.enabled);
	// Sync enabled state when prop changes (e.g., emergency disable shortcut)
	React.useEffect(() => setEnabled(theme.enabled), [theme.enabled]);
	const [css, setCSS] = React.useState(theme.css);
	const [loading, setLoading] = React.useState(false);
	const [themeStyle] = React.useState(() => themeStyles[url] ?? (themeStyles[url] = new StyleTag(url, unloads)));
	// Neptune theme manifest support
	const [manifest, setManifest] = React.useState(() => parseManifest(theme.css));
	const name = manifest?.name ?? url;

	const toggleEnabled = React.useCallback((_: unknown, checked: boolean) => {
		setEnabled((themes[url].enabled = checked));
		themeStyle.css = checked ? themes[url].css : undefined;
	}, []);
	const [error, setError] = React.useState<string>();
	/** `ask`: the user clicked Reload, so a theme from an origin the page can't read yet (added before Luna checked origins) may ask to allow it */
	const loadCSS = React.useCallback(async (ask = false) => {
		setLoading(true);
		setError(undefined);
		try {
			let text: string;
			try {
				text = await ftch.text(url);
			} catch (err) {
				if (!ask || (await __LunaCore.pageStores()).includes(new URL(url).origin)) throw err;
				const access = await allowSource(url);
				if (access === "denied") return setError(`Not allowed: ${new URL(url).origin}`);
				if (access === "reload") return setError(reloadToRead(url));
				text = await ftch.text(url);
			}
			const css = (themes[url].css = text);
			setCSS(css);
			// Reloading an enabled theme has to restyle the page, not only update what is stored
			if (themes[url]?.enabled) themeStyle.css = css;
			setManifest(parseManifest(css));
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
				name={name}
				desc={error ?? manifest?.description}
				author={manifest?.author}
				link={url}
				children={
					<>
						<Tooltip
							title={enabled ? `Disable ${name}` : `Enable ${name}`}
							children={<LunaSwitch checked={enabled} loading={loading} onChange={toggleEnabled} />}
						/>
						<SpinningButton title="Reload theme" spin={loading} disabled={loading} onClick={() => loadCSS(true)} />
						<LunaTrashButton title="Uninstall plugin" onClick={uninstall} />
					</>
				}
			/>
		</Stack>
	);
});
