import React from "react";
import Chip from "@mui/material/Chip";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import WarningIcon from "@mui/icons-material/Warning";
import ErrorIcon from "@mui/icons-material/Error";
import PauseCircleIcon from "@mui/icons-material/PauseCircle";
import { green, yellow, red, grey } from "@mui/material/colors";

export type PluginStatus = "working" | "warning" | "error" | "disabled";

interface PluginStatusBadgeProps {
    status: PluginStatus;
    size?: "small" | "medium";
}

const STATUS_CONFIG = {
    working: {
        label: "Working",
        icon: CheckCircleIcon,
        color: green[500],
        bgColor: `${green[500]}20`,
    },
    warning: {
        label: "Warning",
        icon: WarningIcon,
        color: yellow[700],
        bgColor: `${yellow[700]}20`,
    },
    error: {
        label: "Error",
        icon: ErrorIcon,
        color: red[500],
        bgColor: `${red[500]}20`,
    },
    disabled: {
        label: "Disabled",
        icon: PauseCircleIcon,
        color: grey[500],
        bgColor: `${grey[500]}20`,
    },
};

export const PluginStatusBadge = React.memo(({ status, size = "small" }: PluginStatusBadgeProps) => {
    const config = STATUS_CONFIG[status];
    const Icon = config.icon;

    return (
        <Chip
            icon={<Icon style={{ color: config.color }} />}
            label={config.label}
            size={size}
            sx={{
                backgroundColor: config.bgColor,
                color: config.color,
                fontWeight: 600,
                border: `1px solid ${config.color}40`,
            }}
        />
    );
});
