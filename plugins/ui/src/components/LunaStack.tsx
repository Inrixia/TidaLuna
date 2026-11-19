import type React from "react";

import type { TypographyProps } from "@mui/material";
import type { StackProps } from "@mui/material/Stack";
import { createLunaStack } from "./createLunaStack";
import type { LunaTitleValues } from "./LunaTitle";

export type LunaStackProps = StackProps & { variant?: TypographyProps["variant"]; titleChildren?: React.ReactNode } & Partial<LunaTitleValues>;

export const LunaStack = createLunaStack("LunaStack");
