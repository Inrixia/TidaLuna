import { grey } from "@mui/material/colors";
import { createTheme } from "@mui/material/styles";

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
