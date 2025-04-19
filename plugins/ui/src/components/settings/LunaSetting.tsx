import React from "react";

import Box from "@mui/material/Box";
import Stack, { type StackProps } from "@mui/material/Stack";
import { LunaTitle, type LunaTitleValues } from "../LunaTitle";

export type LunaSettingProps = StackProps & LunaTitleValues;
export const LunaSetting = React.memo((props: LunaSettingProps) => (
	<Stack direction="row" {...props} title={undefined}>
		<LunaTitle sx={{ flexShrink: 0 }} variant="h8" title={props.title} desc={props.desc} />
		<Box sx={{ flexGrow: 1 }} children={props.children} />
	</Stack>
));
