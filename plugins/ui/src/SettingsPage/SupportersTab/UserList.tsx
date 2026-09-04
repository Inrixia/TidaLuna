import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import React from "react";

import { descSx, liftSx, wave } from "../../tidalTokens";

type User = {
	login: string;
	avatarUrl: string;
	url: string;
};

/**
 * The one place tiles are correct, because people have avatars. No borders, no shadows, no pills:
 * a circular avatar over a name, laid out on an auto-fill grid.
 */
export const UserList = React.memo(({ users }: { users: User[] }) => (
	<Box
		sx={{
			display: "grid",
			gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
			gap: 2,
		}}
	>
		{users.map(({ login, avatarUrl, url }) => (
			<Box
				key={login}
				component="a"
				href={url}
				target="_blank"
				rel="noreferrer"
				title={login}
				sx={{
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					gap: 1,
					padding: 1,
					borderRadius: wave.radiusSmall,
					textDecoration: "none",
					"&:hover": liftSx,
				}}
			>
				<Avatar src={avatarUrl} sx={{ width: 48, height: 48 }} />
				<Typography sx={{ ...descSx, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} children={login} />
			</Box>
		))}
	</Box>
));
