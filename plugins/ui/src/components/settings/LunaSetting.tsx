import React from "react";

import Box from "@mui/material/Box";
import Stack, { type StackProps } from "@mui/material/Stack";
import { LunaTitle, type LunaTitleValues } from "../LunaTitle";

export type LunaSettingProps = Omit<StackProps, "title"> & LunaTitleValues;
export const LunaSetting = React.memo((props: LunaSettingProps) => {
	const { title, desc, variant, children, sx, ...stackProps } = props;
	return (
		<Stack direction="row" {...stackProps} sx={[{ alignItems: "center" }, ...(Array.isArray(sx) ? sx : [sx])]}>
			<LunaTitle sx={{ flexShrink: 0 }} variant={variant ?? "h8"} title={title} desc={desc} />
			<Box sx={{ display: "flex", flexGrow: 1 }} children={children} />
		</Stack>
	);
});
