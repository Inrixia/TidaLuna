import React from "react";

import Box from "@mui/material/Box";

// The icons Tidal's sprite does not contain, drawn rather than pulled from a second icon pack.
// Weight is taken from the sprite: general__add is a 1.5 unit bar in a 24 unit box.
interface DrawnProps {
	size?: number;
	sx?: object;
}

// Same 90% ink normalisation the sprite icons get, these sit directly beside them
const Drawn = ({ size = 18, sx, crop, children }: DrawnProps & { crop: string; children: React.ReactNode }) => (
	<Box
		component="svg"
		viewBox={crop}
		width={size}
		height={size}
		focusable="false"
		aria-hidden
		sx={{
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 1.5,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			display: "block",
			flexShrink: 0,
			...sx,
		}}
		children={children}
	/>
);

/** Plugins. A puzzle piece: the one shape that reads as "something that plugs into something else". */
export const PuzzleIcon = (p: DrawnProps) => (
	<Drawn
		crop="1.50 0.75 20.00 20.00"
		{...p}
		children={
			<path d="M9.5 4.5a2 2 0 0 1 4 0 2 2 0 0 1-.15.75H17a1 1 0 0 1 1 1v3.1a2 2 0 0 0-.75-.15 2 2 0 0 0 0 4 2 2 0 0 0 .75-.15V18a1 1 0 0 1-1 1h-3.85a2 2 0 0 0 .15-.75 2 2 0 0 0-4 0 2 2 0 0 0 .15.75H6a1 1 0 0 1-1-1V6.25a1 1 0 0 1 1-1h3.65a2 2 0 0 1-.15-.75Z" />
		}
	/>
);

/** Settings. Sliders, matching the control the tab actually leads to. */
export const SlidersIcon = (p: DrawnProps) => (
	<Drawn
		crop="2.28 2.28 19.44 19.44"
		{...p}
		children={
			<>
				<path d="M4 7h4M12 7h8M4 17h8M16 17h4M4 12h12M20 12h0" />
				<circle cx="10" cy="7" r="2" />
				<circle cx="14" cy="17" r="2" />
				<circle cx="18" cy="12" r="2" />
			</>
		}
	/>
);

/** Reload. Tidal's nearest symbol, general__clock-counterclockwise, means listening history */
export const RefreshIcon = (p: DrawnProps) => (
	<Drawn
		crop="2.83 2.83 18.33 18.33"
		{...p}
		children={
			<>
				<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
				<path d="M19.5 4.5V9H15" />
			</>
		}
	/>
);

/** Minus. general__add's bar without the upright, at the same 1.5 weight and the same 6-18 span. */
export const MinusIcon = (p: DrawnProps) => <Drawn crop="4.50 4.50 15.00 15.00" {...p} children={<path d="M6 12h12" />} />;

/** A plugin that is installed but off. The sprite has no empty circle. */
export const CircleIcon = (p: DrawnProps) => <Drawn crop="3.39 3.39 17.22 17.22" {...p} children={<circle cx="12" cy="12" r="7" />} />;

/** Reveal a secret. The sprite has no eye. */
export const EyeIcon = (p: DrawnProps) => (
	<Drawn
		crop="0.61 0.61 22.78 22.78"
		{...p}
		children={
			<>
				<path d="M2.5 12S6 5.75 12 5.75 21.5 12 21.5 12 18 18.25 12 18.25 2.5 12 2.5 12Z" />
				<circle cx="12" cy="12" r="2.75" />
			</>
		}
	/>
);

/** Hide a secret. The eye with the slash the sprite uses on general__no-internet. */
export const EyeOffIcon = (p: DrawnProps) => (
	<Drawn
		crop="0.61 0.61 22.78 22.78"
		{...p}
		children={
			<>
				<path d="M4.5 8.5C3.2 9.9 2.5 12 2.5 12S6 18.25 12 18.25c1.4 0 2.66-.34 3.76-.87M9.4 6.1A8.6 8.6 0 0 1 12 5.75c6 0 9.5 6.25 9.5 6.25s-1.05 1.88-2.9 3.44" />
				<path d="M10.06 10.06a2.75 2.75 0 0 0 3.88 3.88" />
				<path d="M4 4l16 16" />
			</>
		}
	/>
);
