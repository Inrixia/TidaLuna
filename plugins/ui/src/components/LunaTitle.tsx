import Box from "@mui/material/Box";
import Typography, { type TypographyProps } from "@mui/material/Typography";
import React from "react";

export type LunaTitleValues = {
	title: React.ReactNode;
	desc?: React.ReactNode;
	variant?: TypographyProps["variant"];
};
export type LunaTitleProps = Omit<TypographyProps, "title"> & LunaTitleValues;
export const LunaTitle = React.memo((props: LunaTitleProps) => {
	const { title, desc, variant = "h6", children, ...typographyProps } = props;
	return (
		<Box>
			<Typography {...typographyProps} variant={variant}>
				<Box component="span" sx={{ display: "flex", alignItems: "center", gap: 1 }}>
					{title}
					{children}
				</Box>
			</Typography>
			{desc && <Typography variant="subtitle2" gutterBottom children={desc} />}
		</Box>
	);
});
