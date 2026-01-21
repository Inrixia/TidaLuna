import { ftch } from "@luna/core";
import React from "react";
import { LunaLink, LunaSettings } from "../../components";
import { UserList } from "./UserList";

type Sponsor = {
	login: string;
	avatarUrl: string;
	url: string;
};
export const GitHubSponsors = React.memo(() => {
	const [sponsors, setSponsors] = React.useState<Sponsor[]>([]);
	const [loading, setLoading] = React.useState(true);

	React.useEffect(() => {
		const fetchSponsors = async () => {
			setLoading(true);
			setSponsors(await ftch.json<Sponsor[]>(`https://sponsors.hug.rip`));
			setLoading(false);
		};
		fetchSponsors();
	}, []);

	return (
		<LunaSettings title={(<LunaLink href="https://github.com/sponsors/Inrixia" children="Sponsors ❤️" />) as any}>
			{loading && <div>Loading sponsors…</div>}
			<UserList users={sponsors} />
		</LunaSettings>
	);
});
