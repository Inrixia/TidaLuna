// Tidal's own design tokens, exposed as CSS custom properties on :root. Fallbacks are what Tidal
// 2.43 resolves to. Single style source for every settings tab, nothing else defines a surface,
// border, radius or shadow.
export const wave = {
	// Surfaces, darkest to lightest. Raised means lighter, not shadowed, there is nothing to darken
	surface: "var(--wave-color-solid-base-bright, #18181b)",
	surfaceRaised: "var(--wave-color-solid-base-brighter, #242429)",
	surfaceHover: "var(--wave-color-solid-base-brightest, #303036)",

	// Text
	text: "var(--wave-color-text-main, #fff)",
	textSecondary: "var(--wave-color-text-secondary, #afafb6)",
	textTertiary: "var(--wave-color-text-tertiary, #787887)",
	danger: "var(--wave-color-text-danger, #ff4242)",
	warning: "var(--wave-color-opacity-special-fill-ultra-thick, #ffbe7dcc)",
	/** Only ever the focus ring, the checked switch track, and link hover. Never a border or badge fill. */
	accent: "var(--wave-color-text-link, #33ffee)",

	// Hairlines
	line: "var(--wave-color-opacity-contrast-fill-ultra-thin, #ffffff1a)",
	lineStrong: "var(--wave-color-opacity-contrast-fill-thin, #ffffff33)",

	// Radii
	radius: "var(--wave-border-radius--regular, 12px)",
	radiusSmall: "var(--wave-border-radius--small, 8px)",
	radiusTiny: "var(--wave-border-radius--extra-small, 4px)",
	/** Pill. Tidal's own button component uses this in every size it ships, down to the small one. */
	radiusFull: "var(--wave-border-radius--full, 1000px)",

	// Type, matching what Tidal's own settings rows compute to
	font: '"Square Sans Text VF", "Square Sans Text", Helvetica, Arial, sans-serif',
} as const;

// Tidal's glass, read off its search field, its back/forward pill and the player bar's ::after
export const glassSx = {
	backgroundColor: "rgba(40, 40, 40, 0.75)",
	backdropFilter: "blur(20px) saturate(1.8)",
	WebkitBackdropFilter: "blur(20px) saturate(1.8)",
} as const;

// Hover over glass. Translucent, an opaque fill would switch the blur off under the pointer
export const glassHoverSx = { backgroundColor: "rgba(64, 64, 64, 0.82)" } as const;

// Hover and open states inside a glass panel, translucent for the same reason
export const liftSx = { backgroundColor: "rgba(255, 255, 255, 0.06)" } as const;

/** Row and group geometry. Every number is a multiple of 4. */
export const metrics = {
	rowH: 68,
	rowHCompact: 52,
	rowPadX: 16,
	rowPadY: 15,
	/** Leading status column */
	leadSlot: 20,
	gutter: 12,
	/** rowPadX + leadSlot + gutter, so a sub row lines up with the parent's text column */
	indent: 48,
	controlMinW: 120,
	iconBtn: 32,
	/** A 1900px wide row puts its trailing control a mouse-metre from its title */
	maxTextW: 960,
} as const;

// Four type steps and nothing else
export const sectionSx = { fontFamily: wave.font, fontSize: 16, fontWeight: 600, color: wave.text, lineHeight: "24px" } as const;
export const titleSx = { fontFamily: wave.font, fontSize: 14, fontWeight: 600, color: wave.text, lineHeight: "20px" } as const;
export const descSx = { fontFamily: wave.font, fontSize: 12, fontWeight: 500, color: wave.textSecondary, lineHeight: "18px" } as const;
/** Versions, counts, timestamps, inline state labels */
export const metaSx = { fontFamily: wave.font, fontSize: 11, fontWeight: 500, color: wave.textTertiary, lineHeight: "16px" } as const;

/** The one container. Opaque, lighter than the page, hairline, no shadow. */
export const groupSx = {
	...glassSx,
	// No border, the fill already separates the group from the page
	borderRadius: wave.radius,
	// So the first and last row inherit the rounded corners
	overflow: "hidden",
	// Chromium's scroll anchoring pins the toggle in place and yanks the list when a panel opens
	overflowAnchor: "none",
	boxShadow: "none",
} as const;

/** The one row. */
export const rowSx = {
	display: "grid",
	gridTemplateColumns: `${metrics.leadSlot}px minmax(0, 1fr) auto`,
	columnGap: `${metrics.gutter}px`,
	alignItems: "center",
	minHeight: metrics.rowH,
	padding: `${metrics.rowPadY}px ${metrics.rowPadX}px`,
	backgroundColor: "transparent",
	transition: "background-color 120ms linear",
	"&:not(:first-of-type)": { borderTop: `1px solid ${wave.line}` },
	"&:hover": liftSx,
	"&:focus-visible": { outline: `2px solid ${wave.accent}`, outlineOffset: -2 },
} as const;

/** Neutral by default. Colour is for a destructive item on hover, not for decoration. */
export const iconBtnSx = {
	width: metrics.iconBtn,
	height: metrics.iconBtn,
	padding: 0,
	// Tidal's own 32x32 icon buttons are round
	borderRadius: wave.radiusFull,
	color: wave.textSecondary,
	"&:hover": { color: wave.text, backgroundColor: wave.line },
	"&.Mui-disabled": { color: wave.textTertiary, opacity: 0.4 },
} as const;

// Visible fill plus a hairline, wave.line alone was too low contrast to read as a button
export const buttonSx = {
	fontFamily: wave.font,
	fontSize: 12,
	fontWeight: 600,
	textTransform: "none",
	minWidth: 88,
	// 32 to line up with the icon buttons, padding is Tidal's medium value not its small one
	height: 32,
	paddingX: 2.5,
	// Tidal's button is a pill at every size it ships
	borderRadius: wave.radiusFull,
	color: wave.text,
	backgroundColor: wave.surfaceHover,
	border: `1px solid ${wave.lineStrong}`,
	boxShadow: "none",
	"&:hover": { backgroundColor: wave.lineStrong, borderColor: wave.textTertiary, boxShadow: "none" },
	"&.Mui-disabled": { color: wave.textTertiary, backgroundColor: wave.surface, borderColor: wave.line },
} as const;

// Controls fill with surfaceHover so they stay lighter than the panel they sit inside

// For TextField wrappers, the sx targets the inner OutlinedInput. Every Luna input shares one radius
export const inputSx = {
	"& .MuiOutlinedInput-root": {
		fontFamily: wave.font,
		fontSize: 14,
		color: wave.text,
		backgroundColor: wave.surfaceHover,
		borderRadius: wave.radiusFull,
		"& fieldset": { borderColor: wave.lineStrong },
		"&:hover fieldset": { borderColor: wave.textTertiary },
		"&.Mui-focused fieldset": { borderColor: wave.accent, borderWidth: 1 },
	},
	// Tidal gives its search 44px before the text, these have no icon so they take less
	"& .MuiOutlinedInput-input": { paddingLeft: "20px", paddingRight: "20px" },
	"& .MuiOutlinedInput-input::placeholder": { color: wave.textTertiary, opacity: 1 },
	"& .MuiInputLabel-root": { fontFamily: wave.font, fontSize: 14, color: wave.textTertiary },
	"& .MuiInputLabel-root.Mui-focused": { color: wave.accent },
} as const;

/** For a MUI Select, whose sx lands on the OutlinedInput root itself. */
export const selectSx = {
	fontFamily: wave.font,
	fontSize: 14,
	color: wave.text,
	backgroundColor: wave.surfaceHover,
	borderRadius: wave.radiusFull,
	"& .MuiOutlinedInput-notchedOutline": { borderColor: wave.lineStrong },
	"&:hover .MuiOutlinedInput-notchedOutline": { borderColor: wave.textTertiary },
	"&.Mui-focused .MuiOutlinedInput-notchedOutline": { borderColor: wave.accent, borderWidth: 1 },
	"& .MuiSvgIcon-root": { color: wave.textSecondary },
} as const;

// Lifts the search level with Tidal's own, which sits at y=42 behind a ~56px top bar
export const searchStickyTop = "-44px";

// Above MUI's modal (1300) and tooltip (1500) defaults, so an open tooltip cannot cover an overlay
export const overlayZIndex = 2400;

// Flat, no blur, at this opacity it would not show and would still cost a GPU pass per frame
export const overlayScrim = "rgba(0, 0, 0, 0.86)";

/** Over a thumbnail on hover. Light enough to still read the image underneath. */
export const overlayHoverScrim = "rgba(0, 0, 0, 0.22)";

/** One line, ellipsis, full text belongs in a title attribute. Fixed row height depends on this. */
export const oneLineSx = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

/** Clamp to n lines. No reserved height, the grid stretches cards in a row to match. */
export const clampSx = (lines: number) =>
	({ display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" }) as const;
