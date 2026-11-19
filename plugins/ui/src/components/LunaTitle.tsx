import Box from "@mui/material/Box";
import { styled, useThemeProps } from "@mui/material/styles";
import Typography, { type TypographyProps } from "@mui/material/Typography";
import React from "react";

export type LunaTitleValues = {
	title: React.ReactNode;
	desc?: React.ReactNode;
	variant?: TypographyProps["variant"];
};
export type LunaTitleProps = Omit<TypographyProps, "title"> & LunaTitleValues;

// Themeable via theme.components.LunaTitle, stable classes LunaTitle-root/-title/-desc
const TitleRoot = styled(Box, { name: "LunaTitle", slot: "Root" })({});
const TitleText = styled(Typography, { name: "LunaTitle", slot: "Title" })({});
const TitleDesc = styled(Typography, { name: "LunaTitle", slot: "Desc" })({});

export const LunaTitle = React.memo((inProps: LunaTitleProps) => {
	const props = useThemeProps({ props: inProps, name: "LunaTitle" });
	const { title, desc, variant = "h6", children, className, ...typographyProps } = props;
	return (
		<TitleRoot className="LunaTitle-root">
			<TitleText {...typographyProps} className={className ? `LunaTitle-title ${className}` : "LunaTitle-title"} variant={variant}>
				<Box component="span" sx={{ display: "flex", alignItems: "center", gap: 1 }}>
					{title}
					{children}
				</Box>
			</TitleText>
			{desc && <TitleDesc className="LunaTitle-desc" variant="subtitle2" gutterBottom children={desc} />}
		</TitleRoot>
	);
});
