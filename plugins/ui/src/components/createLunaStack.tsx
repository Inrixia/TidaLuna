import React from "react";

import type { TypographyProps } from "@mui/material";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import { styled, useThemeProps, type CSSObject, type Theme } from "@mui/material/styles";
import type { LunaStackProps } from "./LunaStack";
import { LunaTitle } from "./LunaTitle";

/**
 * Creates a LunaStack like component that is themeable via theme.components[name] (slots root, spacer, content)
 * and has the stable classes `${name}-root`, `${name}-spacer` and `${name}-content`.
 */
export const createLunaStack = (
	name: "LunaStack" | "LunaSettings",
	defaultVariant?: TypographyProps["variant"],
	contentStyles: (theme: Theme) => CSSObject = () => ({}),
) => {
	const Root = styled(Box, { name, slot: "Root" })({});
	const Spacer = styled("div", { name, slot: "Spacer" })({ height: 8 });
	const Content = styled(Stack, { name, slot: "Content" })(({ theme }) => contentStyles(theme));

	const Component = React.memo((inProps: LunaStackProps) => {
		const props = useThemeProps({ props: inProps, name });
		const { title, desc, variant = defaultVariant, titleChildren, ...stackProps } = props;
		return (
			<Root className={`${name}-root`}>
				{title && <LunaTitle variant={variant} title={title} desc={desc} children={titleChildren} />}
				<Spacer className={`${name}-spacer`} />
				<Content spacing={1} {...stackProps} className={stackProps.className ? `${name}-content ${stackProps.className}` : `${name}-content`} />
			</Root>
		);
	});
	Component.displayName = name;
	return Component;
};
