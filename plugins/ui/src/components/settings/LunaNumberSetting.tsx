import React from "react";

import { LunaNumber, type LunaNumberProps } from "../LunaNumber";
import { type LunaTitleValues } from "../LunaTitle";
import { LunaSetting } from "./LunaSetting";

export type LunaNumberSettingProps = LunaNumberProps & LunaTitleValues;
export const LunaNumberSetting = React.memo((props: LunaNumberSettingProps) => (
	<LunaSetting
		title={props.title}
		desc={props.desc}
		children={<LunaNumber size="small" sx={{ marginLeft: "auto" }} {...props} placeholder={props.title} label={null} />}
	/>
));
