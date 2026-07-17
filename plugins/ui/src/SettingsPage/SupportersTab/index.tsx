import Stack from "@mui/material/Stack";
import React from "react";

import { GitHubContributors } from "./GitHubContributors";
import { GitHubSponsors } from "./GitHubSponsors";
import { GitHubStars } from "./GitHubStars";

export const SupportersTab = React.memo(() => (
	<Stack spacing={4}>
		<GitHubSponsors />
		<GitHubContributors />
		<GitHubStars />
	</Stack>
));
