import React from "react";

import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import type { VoidFn } from "@inrixia/helpers";
import { ftch } from "@luna/core";
import { StyleTag } from "@luna/lib";

import { RefreshIcon } from "../../components/LunaDrawnIcons";
import { LunaIcon, icons } from "../../components/LunaIcon";
import { LunaSwitch } from "../../components";
import { LunaRow } from "../../components/LunaList";
import { iconBtnSx, metaSx, wave } from "../../tidalTokens";
import { unloads } from "../../index.safe";
import { themes, themeStyles } from "../Storage";

export type LunaThemeStorage = {
	enabled: boolean;
	css?: string;
};

export const LunaTheme = React.memo(({ theme, url, uninstall }: { theme: LunaThemeStorage; url: string; uninstall: VoidFn }) => {
	const [enabled, setEnabled] = React.useState(theme.enabled);
	React.useEffect(() => setEnabled(theme.enabled), [theme.enabled]);
	const [css, setCSS] = React.useState(theme.css);
	const [loading, setLoading] = React.useState(false);
	const [themeStyle] = React.useState(() => themeStyles[url] ?? (themeStyles[url] = new StyleTag(url, unloads)));
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
			try {
				setManifest(JSON.parse(css.slice(css.indexOf("/*") + 2, css.indexOf("*/"))));
			} catch {}
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

	const name = manifest?.name ?? url;

	return (
		<LunaRow
			title={name}
			desc={manifest?.description ?? url}
			titleAttr={url}
			meta={manifest?.author ? <Typography component="span" sx={{ ...metaSx, flex: "0 0 auto" }} children={`by ${manifest.author}`} /> : undefined}
			trailing={
				<>
					<Tooltip title={enabled ? `Disable ${name}` : `Enable ${name}`}>
						<span>
							<LunaSwitch checked={enabled} loading={loading} onChange={toggleEnabled} />
						</span>
					</Tooltip>
					<Tooltip title="Reload theme">
						<span>
							<IconButton disableRipple disabled={loading} onClick={loadCSS} sx={iconBtnSx} children={<RefreshIcon size={18} />} />
						</span>
					</Tooltip>
					<Tooltip title="Uninstall theme">
						<span>
							<IconButton
								disableRipple
								onClick={uninstall}
								sx={{ ...iconBtnSx, "&:hover": { color: wave.danger, backgroundColor: wave.line } }}
								children={<LunaIcon name={icons.trash} size={18} />}
							/>
						</span>
					</Tooltip>
				</>
			}
		/>
	);
});
