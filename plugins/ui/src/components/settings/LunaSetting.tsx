import React from "react";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

import type { LunaTitleValues } from "../LunaTitle";
import { descSx, metrics, titleSx, wave } from "../../tidalTokens";

export type LunaSettingProps = LunaTitleValues & { children?: React.ReactNode; sx?: object };

/**
 * One setting as a 52px row: text on the left, the control right aligned in a shared 120px column
 * so every switch, select and field line up down one edge instead of ragging. The row title is
 * the control's label, so switches carry no adjacent text. Rows separate by a hairline.
 */
export const LunaSetting = React.memo(({ title, desc, children, sx }: LunaSettingProps) => (
	<Box
		sx={{
			display: "grid",
			gridTemplateColumns: `minmax(0, 1fr) auto`,
			columnGap: `${metrics.gutter}px`,
			alignItems: "center",
			minHeight: metrics.rowHCompact,
			paddingY: 1,
			"&:not(:first-of-type)": { borderTop: `1px solid ${wave.line}` },
			...sx,
		}}
	>
		<Box sx={{ minWidth: 0 }}>
			{typeof title === "string" ? <Typography sx={titleSx} children={title} /> : title}
			{desc !== undefined && (typeof desc === "string" ? <Typography sx={descSx} children={desc} /> : desc)}
		</Box>
		<Box
			sx={{
				display: "flex",
				alignItems: "center",
				justifyContent: "flex-end",
				justifySelf: "end",
				minWidth: metrics.controlMinW,
			}}
			children={children}
		/>
	</Box>
));
