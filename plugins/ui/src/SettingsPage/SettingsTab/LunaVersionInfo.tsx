import React from "react";

import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { LunaSection } from "../../components/LunaList";
import { descSx, sectionSx, titleSx, wave } from "../../tidalTokens";
import { LunaClientUpdate, version } from "./LunaClientUpdate";

export const LunaVersionInfo = React.memo(() => (
	<LunaSection title="Client">
		<Stack spacing={2}>
			<Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
				<Box
					component="img"
					src="https://desktop.tidal.com/assets/appIcon-C2Av_5S7.png"
					alt="TIDAL"
					// No drop shadow: on a black page it darkens nothing and reads as a smudge
					sx={{ width: 56, height: 56, borderRadius: wave.radius }}
				/>
				<Box>
					<Typography sx={{ ...sectionSx, fontSize: 22, lineHeight: "30px" }} children="Thanks for using TIDALuna" />
					<Typography sx={descSx}>
						Version <Box component="span" sx={{ ...titleSx, color: wave.accent }} children={version ?? "Unknown"} />
					</Typography>
				</Box>
			</Stack>
			<LunaClientUpdate />
		</Stack>
	</LunaSection>
));
