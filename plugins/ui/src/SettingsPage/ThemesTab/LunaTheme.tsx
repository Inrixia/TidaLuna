import React from "react";

import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import { LunaLink, LunaSwitch, LunaTrashButton, SpinningButton } from "../../components";

import type { VoidFn } from "@inrixia/helpers";
import { ftch } from "@luna/core";
import { StyleTag } from "@luna/lib";
import { unloads } from "../../index.safe";
import { themes, themeStyles } from "../Storage";
import { parseThemeManifest, themeCodeUrl, themeDisplay, themeKind } from "./themeManifest";
import { describeResources, parseThemeResources } from "./themeResources";

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
	// Manifest support: most themes have none, so the card falls back to a name from the file and the host it came from
	const [manifest, setManifest] = React.useState(() => parseThemeManifest(theme.css));
	const display = themeDisplay(url, manifest);
	const name = display.name;
	// What the file is, from what it contains: a base reworks layout, a colorway is a palette, a font pack has faces
	const kind = themeKind(css);
	// What it pulls in, so a theme loading 13 files from github.com says so on its row
	const loads = React.useMemo(() => describeResources(parseThemeResources(css ?? "", url)), [css, url]);
	// The readable page for the file on github: the raw url only ever shows the css as plain text
	const codeUrl = React.useMemo(() => themeCodeUrl(url), [url]);

	const toggleEnabled = React.useCallback((_: unknown, checked: boolean) => {
		setEnabled((themes[url].enabled = checked));
		themeStyle.css = checked ? themes[url].css : undefined;
	}, []);
	const loadCSS = React.useCallback(async () => {
		setLoading(true);
		try {
			const css = (themes[url].css = await ftch.text(url));
			setCSS(css);
			// Reloading an enabled theme has to restyle the page, not only update what is stored
			if (themes[url]?.enabled) themeStyle.css = css;
			setManifest(parseThemeManifest(css));
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
			direction="row"
			spacing={2}
			sx={{
				borderRadius: 3,
				backgroundColor: "rgba(0, 0, 0, 0.10)",
				padding: 2,
				// The controls sit still while the text beside them wraps
				alignItems: "flex-start",
			}}
		>
			{/* Name on top, then what the theme says about itself, then where it came from: all normal text, not captions */}
			<Box sx={{ flexGrow: 1, minWidth: 0 }}>
				{/* Line height pinned: a theme restyles h6 with a tight one, which clipped the ascenders on its own row */}
				<Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap", marginBottom: 0.5 }}>
					<Typography variant="h6" sx={{ lineHeight: 1.35 }}>
						<LunaLink href={url}>{name}</LunaLink>
					</Typography>
					{/* What the file is. The base carries the theme's own name, shared by every colourway, so without this
					    the base read as if it were the colour file */}
					<Box
						component="span"
						sx={{
							fontSize: "0.7rem !important",
							fontWeight: "600 !important",
							lineHeight: 1.6,
							letterSpacing: "0.04em",
							textTransform: "uppercase",
							padding: "0 6px",
							borderRadius: 1,
							border: "1px solid currentColor",
							opacity: 0.75,
							whiteSpace: "nowrap",
						}}
						children={kind}
					/>
				</Stack>
				{/* Weight pinned with !important: a theme can set `[class*="body"] { font-weight: 800 !important }`, which matched
				    MuiTypography-body2 and made Luna's own settings read as headings */}
				{display.description && <Typography variant="body2" sx={{ lineHeight: 1.5, fontWeight: "400 !important" }} children={display.description} />}
				{display.author && (
					<Typography variant="body2" sx={{ color: "inherit", lineHeight: 1.5, fontWeight: "400 !important" }}>
						by {display.author}
					</Typography>
				)}
				<Typography
					variant="body2"
					sx={{
						color: "inherit",
						opacity: 0.8,
						lineHeight: 1.5,
						fontWeight: "400 !important",
						fontSize: "0.875rem !important",
						overflowWrap: "anywhere",
					}}
				>
					{codeUrl !== undefined ? <LunaLink href={codeUrl}>{display.source}</LunaLink> : display.source}
				</Typography>
				{loads !== undefined && (
					<Typography variant="body2" sx={{ color: "inherit", lineHeight: 1.5, fontWeight: "400 !important", opacity: 0.9 }}>
						{loads}
					</Typography>
				)}
			</Box>
			{/* Controls on the right, in their own row so they never shift with the text */}
			<Stack direction="row" spacing={1} sx={{ alignItems: "center", flexShrink: 0 }}>
				<Tooltip
					title={enabled ? `Disable ${name}` : `Enable ${name}`}
					children={<LunaSwitch checked={enabled} loading={loading} onChange={toggleEnabled} />}
				/>
				<SpinningButton title="Reload theme" spin={loading} disabled={loading} onClick={loadCSS} />
				<LunaTrashButton title="Uninstall theme" onClick={uninstall} />
			</Stack>
		</Stack>
	);
});
