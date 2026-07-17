import React from "react";

import IconButton, { type IconButtonProps } from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";

import DeleteForeverIcon from "@mui/icons-material/DeleteForever";

export const LunaTrashButton = React.memo((props: IconButtonProps) => (
	<Tooltip title={props.title} children={<IconButton color="error" children={<DeleteForeverIcon />} {...props} />} />
));
