import { LunaPlugin } from "@luna/core";
import { store as obyStore } from "oby";

import React, { useEffect, useState } from "react";

import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import { LunaIcon, flipVertical, icons } from "../../components/LunaIcon";
import { LunaPreviewImage } from "../../components/LunaPreviewImage";
import { buttonSx, clampSx, descSx, glassHoverSx, glassSx, metaSx, titleSx, wave } from "../../tidalTokens";
import { previewImageUrl, showDownloadsFor } from "./previewImage";

const authorName = (author: unknown): string | undefined =>
	typeof author === "string" ? author : ((author as { name?: string } | undefined)?.name ?? undefined);
const authorAvatar = (author: unknown): string | undefined =>
	typeof author === "string" ? undefined : ((author as { avatarUrl?: string } | undefined)?.avatarUrl ?? undefined);

// One plugin in the store, as a card
export interface LunaStorePluginProps {
	url: string;
	downloads?: number;
	/** Store wide download opt in, overridden by the plugin's own flag */
	storeShowDownloads?: boolean;
	/** Bumped by the store's reload button to pull fresh metadata for this plugin */
	refreshToken?: number;
}

export const LunaStorePlugin = React.memo(({ url, downloads, storeShowDownloads, refreshToken }: LunaStorePluginProps) => {
	const [plugin, setPlugin] = useState<LunaPlugin | undefined>(undefined);
	const [loadError, setLoadError] = useState<string | undefined>(undefined);
	const [installed, setInstalled] = useState(false);
	const [busy, setBusy] = useState(false);
	const [hovered, setHovered] = useState(false);
	const [btnHover, setBtnHover] = useState(false);
	// A broken or blocked image must leave the card exactly as it was without one
	const [imageBroken, setImageBroken] = useState(false);

	useEffect(() => {
		LunaPlugin.fromStorage({ url })
			.then(setPlugin)
			.catch((err) => setLoadError(String(err?.message ?? err)));
	}, [url]);

	// Reloading the store pulls fresh metadata, otherwise a card keeps whatever the package looked
	// like when it was first rendered this session
	useEffect(() => {
		if (plugin === undefined || !refreshToken) return;
		// Optional call: refreshPackage lives in core, which only updates on a full client restart
		plugin.refreshPackage?.().then(() => setImageBroken(false));
	}, [plugin, refreshToken]);

	// Without this the card keeps offering Install after the plugin is already installed
	useEffect(() => {
		if (plugin === undefined) return;
		setInstalled(plugin.installed);
		return obyStore.on(
			() => plugin.installed,
			() => setInstalled(obyStore.unwrap(plugin.store.installed)),
		);
	}, [plugin]);

	if (!plugin) return null;

	const version = plugin.package?.version;
	const author = authorName(plugin.package?.author);
	// Same host allowlist as the preview image, an avatar url is third party metadata too
	const avatar = previewImageUrl(authorAvatar(plugin.package?.author));
	const preview = imageBroken ? undefined : previewImageUrl(plugin.package?.image);
	const showDownloads = showDownloadsFor(plugin.package?.showDownloads, storeShowDownloads);

	const toggleInstall = async () => {
		setBusy(true);
		try {
			await (installed ? plugin.uninstall() : plugin.install());
		} finally {
			setBusy(false);
		}
	};

	return (
		<Box
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			sx={{
				fontFamily: wave.font,
				display: "flex",
				flexDirection: "column",
				gap: 1,
				height: "100%",
				// No padding on the card itself: a preview has to reach the edges. The padding moves
				// onto the content wrapper below.
				padding: 0,
				overflow: "hidden",
				borderRadius: wave.radius,
				...glassSx,
				...(hovered ? glassHoverSx : null),
				// Installed gets two cues of two kinds: an accent bloom off the left edge, and a button
				// that names the action. No badge or coloured border stacked on top of those.
				backgroundImage: installed
					? `linear-gradient(100deg, color-mix(in srgb, ${wave.accent} 16%, transparent) 0%, transparent 58%)`
					: "none",
				transition: "background-color .15s ease",
			}}
		>
			{preview !== undefined && <LunaPreviewImage src={preview} label={plugin.name} onError={() => setImageBroken(true)} />}
			<Box sx={{ display: "flex", flexDirection: "column", gap: 1, flexGrow: 1, padding: "14px" }}>
			<Stack direction="row" spacing={1} sx={{ alignItems: "flex-start", minWidth: 0 }}>
				{loadError !== undefined && <LunaIcon name={icons.alert} size={16} sx={{ color: wave.danger, flexShrink: 0, marginTop: "2px" }} />}
				<Tooltip title={plugin.name} placement="top-start">
					<Typography sx={{ ...titleSx, ...clampSx(2), flex: 1, minWidth: 0, overflowWrap: "anywhere" }} children={plugin.name} />
				</Tooltip>
				{version && <Typography sx={{ ...metaSx, flex: "0 0 auto", paddingTop: "1px" }} children={version} />}
			</Stack>

			<Typography
				sx={{ ...descSx, ...clampSx(2), flexGrow: 1 }}
				children={loadError ?? plugin.package?.description ?? "No description"}
			/>

			<Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
				{author && (
					<Stack direction="row" spacing={0.75} sx={{ alignItems: "center", minWidth: 0, flexShrink: 1 }}>
						{avatar && <Avatar src={avatar} sx={{ width: 18, height: 18 }} />}
						<Typography sx={{ ...metaSx, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} children={author} />
					</Stack>
				)}
				<Box sx={{ flexGrow: 1 }} />
				{showDownloads && downloads !== undefined && downloads > 0 && (
					<Tooltip title={`${downloads.toLocaleString()} downloads`} placement="top">
						<Stack direction="row" spacing={0.375} sx={{ alignItems: "center", flexShrink: 0, color: wave.textTertiary }}>
							<LunaIcon name={icons.upload} size={13} sx={flipVertical} />
							<Typography sx={{ ...metaSx, fontVariantNumeric: "tabular-nums" }} children={downloads.toLocaleString()} />
						</Stack>
					</Tooltip>
				)}
				<Button
					disableRipple
					disabled={busy}
					onClick={toggleInstall}
					onMouseEnter={() => setBtnHover(true)}
					onMouseLeave={() => setBtnHover(false)}
					// Installed cards say only what the button will do. The state itself is carried by
					// the bloom on the card, so the button does not repeat it back as "Installed".
					startIcon={busy ? null : installed ? <LunaIcon name={icons.trash} size={15} /> : <LunaIcon name={icons.add} size={15} />}
					sx={{
						...buttonSx,
						...(installed
							? {
									backgroundColor: "transparent",
									color: btnHover ? wave.danger : wave.textSecondary,
									borderColor: btnHover ? wave.danger : wave.lineStrong,
								}
							: null),
						// The plus turns a full revolution on its own axis on hover, and dips on press.
						// A full turn, not a quarter: a plus is four-fold symmetric so 90deg lands on itself
						"& .MuiButton-startIcon": {
							marginRight: 0.5,
							// Rest uses the same function list as hover, "none" to rotate(360deg) interpolates as a
							// matrix and a 360deg matrix decomposes back to 0deg
							transform: installed ? "translateY(0px) scale(1)" : "rotate(0deg) scale(1)",
							transition: "transform 420ms cubic-bezier(0.2, 0, 0, 1)",
						},
						"&:hover .MuiButton-startIcon": { transform: installed ? "translateY(-1px) scale(1.1)" : "rotate(360deg) scale(1.15)" },
						"&:active .MuiButton-startIcon": { transform: installed ? "translateY(0px) scale(0.82)" : "rotate(360deg) scale(0.82)" },
						"@media (prefers-reduced-motion: reduce)": {
							"& .MuiButton-startIcon": { transition: "none" },
						},
					}}
					children={busy ? (installed ? "Removing" : "Installing") : installed ? "Remove" : "Install"}
				/>
				</Stack>
			</Box>
		</Box>
	);
});
