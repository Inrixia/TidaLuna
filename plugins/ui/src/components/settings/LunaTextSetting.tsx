import React from "react";

import TextField, { type TextFieldProps } from "@mui/material/TextField";

import { type LunaTitleValues } from "../LunaTitle";
import { inputSx } from "../../tidalTokens";
import { LunaSetting } from "./LunaSetting";

export type LunaTextSettingProps = TextFieldProps & LunaTitleValues;
export const LunaTextSetting = React.memo(({ title, desc, variant, ...props }: LunaTextSettingProps) => (
	<LunaSetting
		title={title}
		desc={desc}
		// No floating label: the row already shows the title on the left, and MUI's floating label
		// sits on the outline and overlaps it on a short field. The title becomes the placeholder.
		children={
			<TextField
				variant="outlined"
				size="small"
				fullWidth
				placeholder={typeof title === "string" ? title : undefined}
				{...props}
				label={undefined}
				sx={{ ...inputSx, ...props.sx }}
			/>
		}
	/>
));
