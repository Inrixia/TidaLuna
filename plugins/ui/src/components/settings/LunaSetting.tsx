import React from "react";

import Box from "@mui/material/Box";
import Stack, { type StackProps } from "@mui/material/Stack";
import { styled, useThemeProps } from "@mui/material/styles";
import { LunaTitle, type LunaTitleValues } from "../LunaTitle";

export type LunaSettingProps = Omit<StackProps, "title"> & LunaTitleValues;

// Themeable via theme.components.LunaSetting, stable classes LunaSetting-root/-control
const SettingRoot = styled(Stack, { name: "LunaSetting", slot: "Root" })({ alignItems: "center" });
const SettingControl = styled(Box, { name: "LunaSetting", slot: "Control" })({ display: "flex", flexGrow: 1 });

export const LunaSetting = React.memo((inProps: LunaSettingProps) => {
	const props = useThemeProps({ props: inProps, name: "LunaSetting" });
	const { title, desc, variant, children, className, ...stackProps } = props;
	return (
		<SettingRoot direction="row" {...stackProps} className={className ? `LunaSetting-root ${className}` : "LunaSetting-root"}>
			<LunaTitle sx={{ flexShrink: 0 }} variant={variant ?? "h8"} title={title} desc={desc} />
			<SettingControl className="LunaSetting-control" children={children} />
		</SettingRoot>
	);
});
