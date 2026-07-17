import Box from "@mui/material/Box";
import React from "react";

import { LunaSecureText, type LunaSecureTextProps } from "../LunaSecureText";
import { type LunaTitleValues } from "../LunaTitle";
import { LunaSetting } from "./LunaSetting";

export type LunaSecureTextSettingProps = LunaSecureTextProps & LunaTitleValues;
export const LunaSecureTextSetting = React.memo((props: LunaSecureTextSettingProps) => (
	<LunaSetting spacing={8} title={props.title} desc={props.desc}>
		<Box flexGrow={1}>
			<LunaSecureText fullWidth size="small" sx={{ marginTop: 0.75 }} {...props} placeholder={props.title} label={null} />
		</Box>
	</LunaSetting>
));
