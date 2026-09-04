import React from "react";
import { LunaStack, type LunaStackProps } from "../LunaStack";

// The panel is not a card. It is the same group surface, delimited by the hairlines of the rows
// above and below it, so its own container adds nothing: no background, no border, no shadow.
export const settingsSx = {
	borderRadius: 0,
	backgroundColor: "transparent",
	boxShadow: "none",
	padding: 0,
} as const;

export const LunaSettings = React.memo((props: LunaStackProps) => <LunaStack {...props} spacing={0} sx={settingsSx} />);
