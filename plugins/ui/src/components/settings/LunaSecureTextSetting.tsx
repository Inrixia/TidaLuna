import React from "react";

import { LunaSecureText, type LunaSecureTextProps } from "../LunaSecureText";
import { type LunaTitleValues } from "../LunaTitle";
import { LunaSetting } from "./LunaSetting";

export type LunaSecureTextSettingProps = LunaSecureTextProps & LunaTitleValues;
export const LunaSecureTextSetting = React.memo((props: LunaSecureTextSettingProps) => (
	<LunaSetting title={props.title} desc={props.desc}>
		<LunaSecureText fullWidth size="small" {...props} placeholder={props.title} label={null} />
	</LunaSetting>
));
