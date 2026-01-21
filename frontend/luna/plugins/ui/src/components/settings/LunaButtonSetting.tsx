import React from "react";

import { LunaButton, type LunaButtonProps } from "../LunaButton";
import type { LunaTitleValues } from "../LunaTitle";
import { LunaSetting } from "./LunaSetting";

export type LunaButtonSettingProps = LunaButtonProps & LunaTitleValues;

export const LunaButtonSetting = React.memo((props: LunaButtonSettingProps) => (
	<LunaSetting
		title={props.title}
		desc={props.desc}
		children={
			<LunaButton
				{...props}
				sx={{
					marginLeft: "auto",
					display: "flex",
					marginRight: 2,
					height: 40,
					...props.sx,
				}}
				children={props.children ?? props.title}
			/>
		}
	/>
));
