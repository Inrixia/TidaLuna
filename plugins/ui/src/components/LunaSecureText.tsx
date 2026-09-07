
import { EyeIcon, EyeOffIcon } from "./LunaDrawnIcons";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import OutlinedInput, { type OutlinedInputProps } from "@mui/material/OutlinedInput";
import Tooltip from "@mui/material/Tooltip";
import React from "react";

export interface LunaSecureTextProps extends OutlinedInputProps {}

export const LunaSecureText = React.memo((props: LunaSecureTextProps) => {
	const [showPassword, setShowPassword] = React.useState(false);
	return (
		<OutlinedInput
			{...props}
			type={showPassword ? "text" : "password"}
			endAdornment={
				<InputAdornment position="end">
					<Tooltip title={showPassword ? "Hide" : "Show"}>
						<IconButton
							sx={{
								color: (theme) => theme.palette.text.secondary,
							}}
							onClick={() => setShowPassword((show) => !show)}
							onMouseDown={(e) => e.preventDefault()}
							onMouseUp={(e) => e.preventDefault()}
							edge="end"
						>
							{showPassword ? <EyeOffIcon size={20} /> : <EyeIcon size={20} />}
						</IconButton>
					</Tooltip>
				</InputAdornment>
			}
		/>
	);
});
