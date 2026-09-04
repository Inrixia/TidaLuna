import React from "react";
import type { SwitchProps } from "@mui/material/Switch";
import { LunaSwitch, type LunaSwitchProps } from "../LunaSwitch";
import type { LunaTitleValues } from "../LunaTitle";
import { LunaSetting } from "./LunaSetting";

export interface LunaSwitchSettingProps extends Omit<SwitchProps, "title">, LunaTitleValues {
    loading?: boolean;
    tooltip?: string;
}

export const LunaSwitchSetting = React.memo((props: LunaSwitchSettingProps) => {
    const { title, desc, variant: _variant, ...rest } = props;
    return <LunaSetting title={title} desc={desc} children={<LunaSwitch {...(rest as LunaSwitchProps)} />} />;
});
