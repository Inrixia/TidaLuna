import type { LunaUnloads } from "@luna/core";
import { Signal } from "@inrixia/helpers";
import { grey } from "@mui/material/colors";
import { createTheme, ThemeProvider, type Theme, type ThemeOptions } from "@mui/material/styles";
import React from "react";

import type { LunaSettingProps } from "./components/settings/LunaSetting";
import type { LunaStackProps } from "./components/LunaStack";
import type { LunaTitleProps } from "./components/LunaTitle";

declare module "@mui/material/styles" {
	interface TypographyVariants {
		h7: React.CSSProperties;
		h8: React.CSSProperties;
		h9: React.CSSProperties;
	}

	// allow configuration using `createTheme`
	interface TypographyVariantsOptions {
		h7?: React.CSSProperties;
		h8?: React.CSSProperties;
		h9?: React.CSSProperties;
	}
}

// Luna components that can be styled via theme.components.<Name>.styleOverrides/defaultProps
declare module "@mui/material/styles" {
	interface ComponentNameToClassKey {
		LunaTitle: "root" | "title" | "desc";
		LunaStack: "root" | "spacer" | "content";
		LunaSettings: "root" | "spacer" | "content";
		LunaSetting: "root" | "control";
	}
	interface ComponentsPropsList {
		LunaTitle: LunaTitleProps;
		LunaStack: LunaStackProps;
		LunaSettings: LunaStackProps;
		LunaSetting: LunaSettingProps;
	}
}

// Update the Typography's variant prop options
declare module "@mui/material/Typography" {
	interface TypographyPropsVariantOverrides {
		h7: true;
		h8: true;
		h9: true;
	}
}

const defaultTheme = createTheme();

export const lunaMuiTheme = createTheme({
	palette: {
		primary: {
			main: grey.A200,
		},
		secondary: {
			main: "#31d8ff",
		},
		text: {
			primary: grey.A200,
			// Grey
			secondary: "#a7a7a9",
		},
	},
	typography: {
		// Inherit the page's own font instead of MUI's default. Luna renders into TIDAL, which sets its typeface on the
		// document, so anything Luna draws in its own root (the confirm dialog is one) came out in Roboto rather than the
		// font the rest of the app uses. `inherit` takes whatever TIDAL set, and still falls back cleanly in a test page.
		fontFamily: "inherit",
		h7: {
			...defaultTheme.typography.h6,
			fontSize: "1.2rem",
		},
		h8: {
			...defaultTheme.typography.h6,
			fontSize: "1.075rem",
		},
		h9: {
			...defaultTheme.typography.h6,
			fontSize: "1.05rem",
		},
		subtitle2: {
			...defaultTheme.typography.subtitle2, // Inherit default subtitle2 styles
			color: grey.A400, // Override the color
		},
	},
	components: {
		MuiTabs: {
			styleOverrides: {
				indicator: ({ theme }) => ({
					display: "flex",
					justifyContent: "center",
					backgroundColor: theme.palette.primary.main,
				}),
			},
		},
		// Add overrides for MuiTab
		MuiTab: {
			styleOverrides: {
				root: ({ theme }) => ({
					minHeight: 0,
					// Target the icon specifically for color changes

					transition: theme.transitions.create("color", {
						duration: theme.transitions.duration.short,
					}),
					// Change color when selected
					"&.Mui-selected": {
						color: theme.palette.text.primary,
						"& .MuiTab-icon": {
							color: theme.palette.secondary.main,
							transition: theme.transitions.create("color", {
								duration: theme.transitions.duration.short,
							}),
							zIndex: 1, // Ensure icon is clickable if overlapping
						},
					},
					// Change color on hover when not selected
					"&:hover:not(.Mui-selected)": {
						color: theme.palette.text.primary,
					},
				}),
			},
		},
		MuiSwitch: {
			styleOverrides: {
				root: {
					padding: 7,
				},
				switchBase: {
					// Styles for the switch thumb when unchecked
					"& + .MuiSwitch-track": {
						opacity: 0.5,
					},
					// Styles for the switch thumb when checked
					"&.Mui-checked": {
						// Need to target the track specifically when checked
						"& + .MuiSwitch-track": {
							opacity: 1,
						},
					},
				},
				track: {
					// General track styles
					opacity: 1,
					borderRadius: 12,
				},
			},
		},
		MuiSelect: {
			styleOverrides: {
				select: {
					backgroundColor: "rgba(0, 0, 0, 0.20)",
				},
			},
		},
		MuiMenu: {
			styleOverrides: {
				paper: {
					backgroundColor: grey[900],
				},
			},
		},
		MuiPaper: {
			styleOverrides: {
				root: {
					backgroundColor: grey[900],
				},
			},
		},
	},
});

export type MuiThemeOverride = ThemeOptions | ((theme: Theme) => ThemeOptions);

const overrides: { override: MuiThemeOverride }[] = [];
const resolve = () =>
	overrides.reduce<Theme>((theme, { override }) => {
		try {
			return createTheme(theme, typeof override === "function" ? override(theme) : override);
		} catch (err) {
			console.error("[@luna/ui] Failed to apply theme override", err);
			return theme;
		}
	}, lunaMuiTheme);

/** The current Luna theme, lunaMuiTheme with all overrides applied */
const currentTheme = new Signal<Theme>(lunaMuiTheme);

export const MuiTheme = {
	/**
	 * Extend the MUI theme used by Luna Settings and the Luna components (LunaSettings, LunaSwitchSetting...).
	 * Merged on top of lunaMuiTheme in registration order, a function gets the theme built so far.
	 * Applied live, reverted when unloads run.
	 * @example
	 * MuiTheme.override(unloads, {
	 * 	components: {
	 * 		LunaSettings: { styleOverrides: { content: { boxShadow: "none" } } },
	 * 		LunaSetting: { styleOverrides: { root: { minHeight: 36 } } },
	 * 	},
	 * });
	 */
	override(unloads: LunaUnloads, override: MuiThemeOverride) {
		const entry = { override };
		overrides.push(entry);
		currentTheme._ = resolve();
		unloads.add(() => {
			const index = overrides.indexOf(entry);
			if (index === -1) return;
			overrides.splice(index, 1);
			currentTheme._ = resolve();
		});
	},
	get current() {
		return currentTheme._;
	},
	/** Called with the new theme whenever overrides change. Returns a function to stop listening. */
	onChange(listener: (theme: Theme) => void) {
		return currentTheme.onValue(listener);
	},
};

/** ThemeProvider with the current Luna theme (lunaMuiTheme + MuiTheme overrides), updates live */
export const LunaMuiThemeProvider = ({ children }: { children?: React.ReactNode }) => {
	const theme = React.useSyncExternalStore(MuiTheme.onChange, () => currentTheme._);
	return React.createElement(ThemeProvider, { theme }, children);
};
