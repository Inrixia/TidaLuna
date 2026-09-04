import React from "react";

import Box from "@mui/material/Box";

// Tidal draws its whole interface from a sprite of ~108 <symbol> elements it mounts into
// <div id="icons-root"> under <body>. Referencing the same sprite gives Luna Tidal's own artwork.
// A reference to an id Tidal does not have renders silently at 0x0, hence the spriteHas check.
export interface TidalIcon {
	/** Symbol id from Tidal's sprite, without the leading hash. */
	id: string;
	// Window onto the symbol that makes its ink fill 90% of the box. Tidal's symbols are not drawn to
	// a common margin, ink runs from 50% (general__add) to 100% (general__alert), so one size value
	// would otherwise draw a plus half the height of the trashcan beside it. 90% is Tidal's median.
	crop: string;
}

export interface LunaIconProps {
	/** Icon from Tidal's sprite. */
	name: TidalIcon;
	/** Box the icon is drawn into. The artwork's own padding decides how much of it is ink. */
	size?: number;
	/** Extra styles, e.g. a transform for a hover animation. */
	sx?: object;
	/** Set when the icon carries meaning no neighbouring text already carries. */
	title?: string;
}

// Only hits are cached, a miss may just mean Tidal has not mounted the sprite yet
const found = new Set<string>();
const spriteHas = (name: string): boolean => {
	if (found.has(name)) return true;
	const el = document.getElementById(name);
	if (el === null || el.tagName.toLowerCase() !== "symbol") return false;
	found.add(name);
	return true;
};

export const LunaIcon = React.memo(({ name, size = 18, sx, title }: LunaIconProps) => {
	if (!spriteHas(name.id)) return null;
	return (
		<Box
			component="svg"
			viewBox={name.crop}
			width={size}
			height={size}
			focusable="false"
			aria-hidden={title === undefined ? true : undefined}
			role={title === undefined ? undefined : "img"}
			sx={{ fill: "currentColor", display: "block", flexShrink: 0, ...sx }}
		>
			{title !== undefined && <title>{title}</title>}
			{/* Explicit 24, without it use fills the viewport and the crop scales with it */}
			<use href={`#${name.id}`} width="24" height="24" />
		</Box>
	);
});

// Named for what they do here, so a Tidal rename is one edit. The sprite has no download arrow,
// so the export icon is its upload arrow turned over.
export const icons = {
	search: { id: "general__search", crop: "0.64 0.71 23.06 23.06" },
	close: { id: "general__close", crop: "4.73 4.72 14.53 14.53" },
	add: { id: "general__add", crop: "5.33 5.33 13.33 13.33" },
	trash: { id: "detail-view__trashcan", crop: "0.17 0.67 22.67 22.67" },
	alert: { id: "general__alert", crop: "-1.33 -1.33 26.67 26.67" },
	check: { id: "general__checkmark", crop: "-1.32 -0.83 26.66 26.66" },
	threeDots: { id: "general__three-dots", crop: "1.33 0.73 21.33 21.33" },
	maximize: { id: "player__maximize", crop: "2 2 20 20" },
	upload: { id: "3.0__upload", crop: "4.78 4.28 14.44 14.44" },
	broadcast: { id: "player__broadcast", crop: "-0.25 -0.5 25 25" },
	noInternet: { id: "general__no-internet", crop: "3.3 3.3 17.41 17.41" },
	shine: { id: "general__shine", crop: "0.97 -0.64 23.67 23.67" },
	marketplace: { id: "general__marketplace", crop: "-0.91 -0.92 25.83 25.83" },
	heart: { id: "general__heart", crop: "-1.33 -0.7 26.54 26.54" },
} as const satisfies Record<string, TidalIcon>;

/** Turns the upload arrow into a download arrow. */
export const flipVertical = { transform: "scaleY(-1)" } as const;
