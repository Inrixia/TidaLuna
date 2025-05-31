import React from "react";

import type { TypographyProps } from "@mui/material";
import Box from "@mui/material/Box";
import type { StackProps } from "@mui/material/Stack";
import Stack from "@mui/material/Stack";
import { LunaTitle, type LunaTitleValues } from "./LunaTitle";

export type LunaStackProps = StackProps & { variant?: TypographyProps["variant"]; titleChildren?: React.ReactNode } & Partial<LunaTitleValues>;

export const LunaStack = React.memo((props: LunaStackProps) => {
	const { title, desc, variant } = props;
	delete props.title;
	return (
		<Box>
			{title && <LunaTitle variant={variant} title={title} desc={desc} children={props.titleChildren} />}
			<div style={{ height: 8 }} />
			<Stack display="flex" spacing={1} {...props} />
		</Box>
	);
});
