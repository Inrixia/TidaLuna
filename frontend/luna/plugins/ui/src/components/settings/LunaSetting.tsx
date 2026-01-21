import React from "react";

import Box from "@mui/material/Box";
import Stack, { type StackProps } from "@mui/material/Stack";
import { LunaTitle, type LunaTitleValues } from "../LunaTitle";

export type LunaSettingProps = Omit<StackProps, "title"> & LunaTitleValues;
export const LunaSetting = React.memo((props: LunaSettingProps) => {
	const { title, desc, variant, children, ...stackProps } = props;
	return (
		<Stack direction="row" alignItems="center" {...stackProps}>
			<LunaTitle sx={{ flexShrink: 0 }} variant={variant ?? "h8"} title={title} desc={desc} />
			<Box display="flex" sx={{ flexGrow: 1 }} children={children} />
		</Stack>
	);
});
