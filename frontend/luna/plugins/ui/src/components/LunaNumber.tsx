import React from "react";

import InputAdornment from "@mui/material/InputAdornment";

import AddIcon from "@mui/icons-material/Add";
import RemoveIcon from "@mui/icons-material/Remove";
import { useTheme } from "@mui/material/styles";
import TextField, { type TextFieldProps } from "@mui/material/TextField";

export type LunaNumberProps = TextFieldProps & {
	min?: number;
	max?: number;
	value?: number;
	defaultValue?: number;
	onNumber?: (num: number) => unknown;
};

export const LunaNumber = React.memo((props: LunaNumberProps) => {
	const theme = useTheme();
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
							<RemoveIcon
								sx={{
									color: theme.palette.text.secondary,
									cursor: "pointer",
								}}
								onClick={() => onNumber(number - 1)}
							/>
						</InputAdornment>
					),
					endAdornment: (
						<InputAdornment position="end">
							<AddIcon
								sx={{
									color: theme.palette.text.secondary,
									cursor: "pointer",
								}}
								onClick={() => onNumber(number + 1)}
							/>
						</InputAdornment>
					),
				},
			}}
			onChange={(e) => onNumber(e.target.value)}
			inputProps={{
				style: { textAlign: "center" },
			}}
			value={number}
			{...props}
			sx={{
				width: 128,
				...props.sx,
			}}
		/>
	);
});
