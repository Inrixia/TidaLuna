import React from "react";

import { Tooltip } from "@mui/material";
import Link, { type LinkProps } from "@mui/material/Link";

export interface LunaLinkProps extends LinkProps {}
export const LunaLink = React.memo((props: LunaLinkProps) => {
	const href = props.href ?? (typeof props.children === "string" ? props.children : undefined);
	if (!href?.startsWith("http")) return <>{props.children}</>;
	return (
		<Tooltip
			title={href}
			children={
				<Link
					{...props}
					sx={{
						textDecoration: "none !important",
					}}
					href={href}
					target={"_blank"}
				/>
			}
		/>
	);
});
