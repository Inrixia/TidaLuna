import React from "react";

import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import { LunaLink, LunaSwitch, LunaTrashButton, SpinningButton } from "../../components";

import type { VoidFn } from "@inrixia/helpers";
import { unloads } from "../../index.safe";
import { LunaTheme, resourceProgress, type ThemeData } from "./LunaTheme";
import { ThemeManifest } from "./ThemeManifest";
import { ThemeResources } from "./ThemeResources";

/** One installed theme, as a row in the themes tab */
export const ThemeRow = React.memo(({ theme: data, url, uninstall }: { theme: ThemeData; url: string; uninstall: VoidFn }) => {
	// The theme itself: the startup applied every stored one, and one that arrived since (an imported backup) is taken over
	// here so its row can be switched. A record that should never have been written has no theme, and its row still shows.
	const theme = React.useMemo(() => {
		const known = LunaTheme.themes.get(url);
		if (known !== undefined) return known;
		try {
			return LunaTheme.from(url, data, unloads);
		} catch {
			return undefined;
		}
	}, [url]);

	const [enabled, setEnabled] = React.useState(data.enabled);
	// Sync enabled state when the prop changes (e.g., emergency disable shortcut)
	React.useEffect(() => setEnabled(data.enabled), [data.enabled]);
	const [css, setCSS] = React.useState(data.css);
	const [loading, setLoading] = React.useState(false);
	// Manifest support: most themes have none, so the row falls back to a name from the file and the host it came from.
	// What the file is and what it pulls in are read from the one manifest the theme already holds
	const manifest = theme?.manifest ?? ThemeManifest.from(url, css);
	const loads = React.useMemo(() => ThemeResources.from(css ?? "", url).describe(), [css, url]);
	// Checking every file takes a moment on a font pack, so the row says so rather than looking finished
	const [progress, setProgress] = React.useState(() => resourceProgress._[url]);
	React.useEffect(() => {
		const stop = resourceProgress.onValue((all) => setProgress(all[url]));
		return () => {
			stop();
		};
	}, [url]);

	const toggleEnabled = React.useCallback(
		(_: unknown, checked: boolean) => {
			setEnabled(checked);
			if (theme === undefined) return;
			// enable() fetches and re-applies when the theme has no css yet, and never rejects: a failed fetch turns it off
			if (checked) theme.enable();
			else theme.disable();
		},
		[theme],
	);
	const reload = React.useCallback(async () => {
		if (theme === undefined) return;
		setLoading(true);
		try {
			await theme.reload();
		} finally {
			setCSS(theme.data.css);
			setLoading(false);
		}
	}, [theme]);

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
						<LunaLink href={url}>{manifest.name}</LunaLink>
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
						children={manifest.kind}
					/>
				</Stack>
				{/* Weight pinned with !important: a theme can set `[class*="body"] { font-weight: 800 !important }`, which matched
				    MuiTypography-body2 and made Luna's own settings read as headings */}
				{manifest.description && (
					<Typography variant="body2" sx={{ lineHeight: 1.5, fontWeight: "400 !important" }} children={manifest.description} />
				)}
				{manifest.author && (
					<Typography variant="body2" sx={{ color: "inherit", lineHeight: 1.5, fontWeight: "400 !important" }}>
						by {manifest.author}
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
					{manifest.codeUrl !== undefined ? <LunaLink href={manifest.codeUrl}>{manifest.source}</LunaLink> : manifest.source}
				</Typography>
				{(loads !== undefined || progress !== undefined) && (
					<Typography variant="body2" sx={{ color: "inherit", lineHeight: 1.5, fontWeight: "400 !important", opacity: 0.9 }}>
						{progress !== undefined ? `checking ${progress.done} of ${progress.total} files` : loads}
					</Typography>
				)}
			</Box>
			{/* Controls on the right, in their own row so they never shift with the text */}
			<Stack direction="row" spacing={1} sx={{ alignItems: "center", flexShrink: 0 }}>
				<Tooltip
					title={enabled ? `Disable ${manifest.name}` : `Enable ${manifest.name}`}
					children={<LunaSwitch checked={enabled} loading={loading} onChange={toggleEnabled} />}
				/>
				<SpinningButton title="Reload theme" spin={loading} disabled={loading || theme === undefined} onClick={reload} />
				<LunaTrashButton title="Uninstall theme" onClick={uninstall} />
			</Stack>
		</Stack>
	);
});
