import React from "react";

import type { LunaUnload } from "@luna/core";
import { redux } from "@luna/lib";

import Box from "@mui/material/Box";
import Fade from "@mui/material/Fade";
import IconButton from "@mui/material/IconButton";
import Modal from "@mui/material/Modal";
import Typography from "@mui/material/Typography";

import { LunaIcon, icons } from "./LunaIcon";
import { iconBtnSx, metaSx, overlayHoverScrim, overlayScrim, overlayZIndex, wave } from "../tidalTokens";

export interface LunaPreviewImageProps {
	src: string;
	/** Names the thing the image belongs to. Becomes the caption and the overlay's accessible name. */
	label: string;
	/** Fired when the image cannot be loaded, so the caller can drop the preview entirely. */
	onError?: () => void;
}

// A cropped thumbnail that opens the full image over the app. Modal rather than a hand rolled
// portal for the focus trap, Escape and focus return; Modal rather than Dialog because lunaTheme
// paints every Paper grey900. Scroll lock is off since it writes padding onto Tidal's body, clicks
// are stopped because a portal still bubbles React events up the tree it was declared in, and
// navigating away closes it because Page.removeFromDOM never unmounts the React root.
export const LunaPreviewImage = React.memo(({ src, label, onError }: LunaPreviewImageProps) => {
	const [open, setOpen] = React.useState(false);
	const close = React.useCallback(() => setOpen(false), []);
	const captionId = React.useId();
	const imgProps = { component: "img", src, alt: "", decoding: "async", referrerPolicy: "no-referrer" } as const;

	React.useEffect(() => {
		if (!open) return;
		const unIntercept = redux.intercept("router/NAVIGATED", new Set<LunaUnload>(), close);
		return () => void unIntercept();
	}, [open, close]);

	return (
		<>
			<Box
				component="button"
				type="button"
				aria-haspopup="dialog"
				aria-label={`Enlarge the preview of ${label}`}
				onClick={(event: React.MouseEvent) => {
					event.stopPropagation();
					setOpen(true);
				}}
				sx={{
					appearance: "none",
					margin: 0,
					padding: 0,
					border: 0,
					background: "none",
					font: "inherit",
					color: "inherit",
					display: "block",
					position: "relative",
					width: "100%",
					flexShrink: 0,
					overflow: "hidden",
					cursor: "zoom-in",
					"&:focus-visible": { outline: `2px solid ${wave.accent}`, outlineOffset: -2 },
					"&:hover .LunaPreviewImage-scrim, &:focus-visible .LunaPreviewImage-scrim": { opacity: 1 },
					"@media (prefers-reduced-motion: reduce)": {
						"& .LunaPreviewImage-scrim": { transition: "none" },
					},
				}}
			>
				<Box {...imgProps} loading="lazy" onError={onError} sx={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", display: "block" }} />
				{/* One cue, not three. The image does not also zoom on hover: that gesture is the most
				    recognisable stock template tell there is, and it was a second sticker saying what the
				    scrim already says. The scrim stays light enough to read the screenshot through. */}
				<Box
					className="LunaPreviewImage-scrim"
					sx={{
						position: "absolute",
						inset: 0,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						backgroundColor: overlayHoverScrim,
						opacity: 0,
						transition: "opacity 160ms linear",
						pointerEvents: "none",
					}}
					children={<LunaIcon name={icons.maximize} size={22} sx={{ color: wave.text }} />}
				/>
			</Box>

			<Modal
				open={open}
				onClose={close}
				closeAfterTransition
				disableScrollLock
				slotProps={{ backdrop: { timeout: 200, easing: "cubic-bezier(0.2, 0, 0, 1)", sx: { backgroundColor: overlayScrim } } }}
				sx={{ zIndex: overlayZIndex, display: "flex", alignItems: "center", justifyContent: "center", padding: 5 }}
			>
				<Fade in={open} timeout={200} easing="cubic-bezier(0.2, 0, 0, 1)">
					{/* Modal's own root is hard coded role="presentation", so the dialog semantics have to
					    live here. Clicking anywhere closes, the image included: having to hunt for the
					    backdrop to get back out is the part people actually complain about. */}
					<Box
						role="dialog"
						aria-modal="true"
						aria-labelledby={captionId}
						onClick={(event: React.MouseEvent) => {
							event.stopPropagation();
							close();
						}}
						sx={{
							outline: "none",
							display: "flex",
							flexDirection: "column",
							alignItems: "center",
							gap: 1.5,
							maxWidth: "100%",
							maxHeight: "100%",
							minHeight: 0,
							cursor: "zoom-out",
						}}
					>
						<IconButton
							disableRipple
							aria-label="Close preview"
							onClick={(event) => {
								event.stopPropagation();
								close();
							}}
							// Fixed to the viewport so it never lands on the screenshot. Works only while Fade
							// animates opacity alone, a transform would make this a containing block.
							sx={{
								...iconBtnSx,
								position: "fixed",
								top: 16,
								right: 16,
								width: 36,
								height: 36,
								// The one justified deviation from the shared token: it has to read against
								// an arbitrary screenshot, so it cannot be transparent.
								backgroundColor: wave.surface,
								"&:hover": { color: wave.text, backgroundColor: wave.surfaceHover },
								"&:focus-visible": { outline: `2px solid ${wave.accent}`, outlineOffset: -2 },
							}}
							children={<LunaIcon name={icons.close} size={20} />}
						/>
						{/* The image box takes whatever height the caption leaves, and maxHeight 100% of
						    that bounds the image. No viewport arithmetic, so a caption that wraps to two
						    lines cannot push the image off screen. */}
						<Box sx={{ flex: "1 1 auto", minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
							<Box {...imgProps} sx={{ maxWidth: "min(1440px, 100%)", maxHeight: "100%", display: "block", borderRadius: wave.radius }} />
						</Box>
						<Typography id={captionId} sx={{ ...metaSx, textAlign: "center", flexShrink: 0 }} children={label} />
					</Box>
				</Fade>
			</Modal>
		</>
	);
});
