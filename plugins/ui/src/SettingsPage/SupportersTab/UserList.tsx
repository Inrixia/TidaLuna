import Grid from "@mui/material/Grid";
import React from "react";
import { LunaAuthorDisplay } from "../../components";

type User = {
	login: string;
	avatarUrl: string;
	url: string;
};

export const UserList = React.memo(({ users }: { users: User[] }) => (
	<Grid spacing={2} container>
		{users.map(({ login, avatarUrl, url }) => (
			<Grid
				key={login}
				children={
					<LunaAuthorDisplay
						sx={{
							background: "rgba(0, 0, 0, 0.1)",
							borderRadius: 2,
							padding: 1,
						}}
						author={{ name: login, avatarUrl, url }}
						prefix=""
					/>
				}
			/>
		))}
	</Grid>
));
