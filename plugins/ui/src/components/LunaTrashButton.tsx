import React from "react";

import IconButton, { type IconButtonProps } from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";

export const LunaTrashButton = React.memo((props: IconButtonProps) => (
	<Tooltip title={props.title} children={<IconButton disableRipple sx={{ color: "var(--wave-color-text-secondary, #afafb6)", "&:hover": { color: "var(--wave-color-text-danger, #ff4242)" } }} children={<LunaIcon name={icons.trash} size={18} />} {...props} />} />
));
import { LunaIcon, icons } from "./LunaIcon";
