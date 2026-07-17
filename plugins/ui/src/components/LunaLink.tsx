import React from "react";

import { Tooltip } from "@mui/material";
import Link, { type LinkProps } from "@mui/material/Link";

export interface LunaLinkProps extends LinkProps {}
export const LunaLink = React.memo((props: LunaLinkProps) => {
	const href = props.href ?? (typeof props.children === "string" ? props.children : undefined);
	return (
		<Tooltip
			title={href}
			children={
				<Link
					{...props}
					sx={{
						textDecoration: "none !important",
					}}
					href={href?.startsWith("http") ? href : ""}
					target={"_blank"}
				/>
			}
		/>
	);
});
