import { type SelectProps } from "@mui/material";
import React from "react";

import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";

import { type LunaTitleValues } from "../LunaTitle";
import { selectSx } from "../../tidalTokens";
import { LunaSetting } from "./LunaSetting";

// Make the props generic
export type LunaSelectSettingProps<T = unknown> = SelectProps<T> & LunaTitleValues;
function _LunaSelectSetting<T = unknown>(props: LunaSelectSettingProps<T>) {
	const { title, desc, ...selectProps } = props;
	return (
		<LunaSetting title={title} desc={desc}>
			<Select<T> size="small" fullWidth {...selectProps} sx={{ ...selectSx, ...selectProps.sx }} />
		</LunaSetting>
	);
}

// Preserve generics when wrapping with React.memo
export const LunaSelectSetting = React.memo(_LunaSelectSetting) as typeof _LunaSelectSetting;

export const LunaSelectItem = MenuItem;
