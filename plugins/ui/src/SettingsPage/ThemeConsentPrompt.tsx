import React from "react";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

import { confirm } from "../helpers/confirm";
import type { ThemeConsent } from "./ThemesTab/ThemeConsent";

/**
 * Ask before installing a theme that downloads files of its own, naming the files and the hosts rather than counting them.
 *
 * The dialog is the one the app already uses, so the answer is a familiar confirm rather than a new kind of prompt.
 */
export const confirmThemeConsent = async (consent: ThemeConsent) => {
	const { confirmed } = await confirm({
		title: consent.title,
		// What and where, not just how many: the host groups name each file
		description: (
			<>
				{consent.description}
				{consent.hosts.map((host) => (
					<Box key={host.host} sx={{ marginTop: 1.5 }}>
						{/* Host then its files: caption size and a faded colour made the list unreadable on a light dialog */}
						<Typography variant="body2" sx={{ fontWeight: "600 !important", lineHeight: 1.5, fontSize: "1rem !important" }} children={host.host} />
						{host.files.map((file) => (
							<Typography
								key={file.url}
								variant="body2"
								title={file.url}
								sx={{ display: "block", lineHeight: 1.5, paddingLeft: 2, fontSize: "0.95rem !important", wordBreak: "break-all" }}
								children={file.label}
							/>
						))}
						{host.hidden > 0 && (
							<Typography variant="body2" sx={{ display: "block", lineHeight: 1.5, paddingLeft: 2, fontSize: "0.95rem !important" }}>
								and {host.hidden} more from {host.host}
							</Typography>
						)}
					</Box>
				))}
			</>
		),
		confirmationText: consent.confirmationText,
	});
	return confirmed;
};
