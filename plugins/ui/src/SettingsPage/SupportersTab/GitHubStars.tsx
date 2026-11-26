import { Tracer } from "@luna/core";
import React from "react";
import { LunaLink, LunaSettings } from "../../components";
import { loadStarCount, STARGAZERS_PAGE } from "./stargazers";

const { trace } = Tracer("[@luna/ui]", null);

export const GitHubStars = React.memo(() => {
	const [count, setCount] = React.useState<number>();
	const [loading, setLoading] = React.useState(true);

	React.useEffect(() => {
		// loadStarCount never rejects, so a failed request can't leave this stuck on "Loading" the way an uncaught
		// rejection did when the stargazer list endpoint started answering 401
		loadStarCount().then((stars) => {
			if (stars === undefined) trace.warn("Could not load the TidaLuna star count");
			setCount(stars);
			setLoading(false);
		});
	}, []);

	return (
		<LunaSettings title={(<LunaLink href={STARGAZERS_PAGE} children="Stargazers ⭐" />) as any}>
			{loading ? (
				<div>Loading stargazers…</div>
			) : count === undefined ? (
				<div>Could not load the star count.</div>
			) : (
				<div>{count.toLocaleString()} people starred TidaLuna on GitHub.</div>
			)}
		</LunaSettings>
	);
});
