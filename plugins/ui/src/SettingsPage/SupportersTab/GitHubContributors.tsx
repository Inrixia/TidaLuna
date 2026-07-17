import { ftch } from "@luna/core";
import React from "react";
import { LunaSettings } from "../../components";
import { UserList } from "./UserList";

type Contributor = {
	login: string;
	avatar_url: string;
	html_url: string;
};

export const GitHubContributors = React.memo(() => {
	const [contributors, setContributors] = React.useState<Contributor[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [page, setPage] = React.useState(1);
	const [hasMore, setHasMore] = React.useState(true);
	const loaderRef = React.useRef<HTMLDivElement | null>(null);

	React.useEffect(() => {
		const fetchContributors = async () => {
			setLoading(true);
			const data = await ftch.json<Contributor[]>(`https://api.github.com/repos/Inrixia/TidaLuna/contributors?per_page=100&page=${page}`);
			setContributors((prev) => [...prev, ...data]);
			setHasMore(data.length === 100);
			setLoading(false);
		};
		if (hasMore) fetchContributors();
	}, [page]);

	React.useEffect(() => {
		if (!hasMore || loading) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting) {
					setPage((p) => p + 1);
				}
			},
			{ threshold: 1 },
		);
		if (loaderRef.current) observer.observe(loaderRef.current);
		return () => observer.disconnect();
	}, [hasMore, loading]);

	return (
		<LunaSettings title="Contributors 👾">
			<UserList
				users={contributors.map(({ login, avatar_url, html_url }) => ({
					login,
					avatarUrl: avatar_url,
					url: html_url,
				}))}
			/>
			<div ref={loaderRef} />
			{loading && <div>Loading contributors…</div>}
		</LunaSettings>
	);
});
