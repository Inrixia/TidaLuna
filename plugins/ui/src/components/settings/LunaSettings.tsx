import { createLunaStack } from "../createLunaStack";

export const settingsSx = {
	borderRadius: 2,
	backgroundColor: "rgba(0, 0, 0, 0.20)",
	boxShadow: 5,
	padding: 2,
	paddingBottom: 1,
};

// Same as settingsSx, but as base styles so theme styleOverrides can change them
export const LunaSettings = createLunaStack("LunaSettings", "h7", (theme) => ({
	borderRadius: Number(theme.shape.borderRadius) * 2,
	backgroundColor: "rgba(0, 0, 0, 0.20)",
	boxShadow: theme.shadows[5],
	padding: theme.spacing(2),
	paddingBottom: theme.spacing(1),
}));
