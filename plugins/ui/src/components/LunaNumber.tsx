import React from "react";

import Box from "@mui/material/Box";
import InputAdornment from "@mui/material/InputAdornment";

import TextField, { type TextFieldProps } from "@mui/material/TextField";

import { MinusIcon } from "./LunaDrawnIcons";
import { LunaIcon, icons } from "./LunaIcon";
import { inputSx, outlinedRootSx, wave } from "../tidalTokens";

/**
 * The steppers sit on the field's own fill, and text.secondary left them barely readable against
 * it. Full text colour on hover plus a round hit area big enough to aim at.
 */
const stepperSx = {
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	width: 22,
	height: 22,
	borderRadius: wave.radiusFull,
	color: wave.textSecondary,
	cursor: "pointer",
	transition: "color 120ms ease, background-color 120ms ease",
	"&:hover": { color: wave.text, backgroundColor: wave.lineStrong },
} as const;

export type LunaNumberProps = TextFieldProps & {
	min?: number;
	max?: number;
	value?: number;
	defaultValue?: number;
	onNumber?: (num: number) => unknown;
};

export const LunaNumber = React.memo((props: LunaNumberProps) => {
	const [number, setNumber] = React.useState<number>(isNaN(props.value!) ? (props.defaultValue ?? 0) : (props.value ?? 0));
	const onNumber = (number: any) => {
		const num = +number;
		if (isNaN(num)) return;
		if (props.max !== undefined && num > props.max) return;
		if (props.min !== undefined && num < props.min) return;
		setNumber(num);
		props.onNumber?.(num);
	};
	return (
		<TextField
			variant="outlined"
			slotProps={{
				input: {
					startAdornment: (
						<InputAdornment position="start">
							<Box
								onClick={() => onNumber(number - 1)}
								sx={stepperSx}
								children={<MinusIcon size={18} />}
							/>
						</InputAdornment>
					),
					endAdornment: (
						<InputAdornment position="end">
							<Box
								onClick={() => onNumber(number + 1)}
								sx={stepperSx}
								children={<LunaIcon name={icons.add} size={18} />}
							/>
						</InputAdornment>
					),
				},
			}}
			onChange={(e) => onNumber(e.target.value)}
			value={number}
			{...props}
			// After the spread, so a caller cannot accidentally drop the centering again
			inputProps={{ style: { textAlign: "center", padding: 0 } }}
			sx={{
				width: 128,
				...inputSx,
				"& .MuiOutlinedInput-root": {
					...outlinedRootSx,
					// Zeroing the input padding to centre the value also collapsed the field, so the
					// height lives on the root instead
					height: 32,
					paddingLeft: 1,
					paddingRight: 1,
				},
				// The value sits between two adornments, so it needs to flex to centre between them
				"& .MuiInputBase-input": { textAlign: "center", padding: 0, flex: 1 },
				...props.sx,
			}}
		/>
	);
});
