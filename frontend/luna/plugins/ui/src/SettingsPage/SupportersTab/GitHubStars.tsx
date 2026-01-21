import { ftch } from "@luna/core";
import React from "react";
import { LunaSettings } from "../../components";
import { UserList } from "./UserList";

type Stargazer = {
	login: string;
	avatar_url: string;
	html_url: string;
};

export const GitHubStars = React.memo(() => {
	const [stars, setStars] = React.useState<Stargazer[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [page, setPage] = React.useState(1);
	const [hasMore, setHasMore] = React.useState(true);
	const loaderRef = React.useRef<HTMLDivElement | null>(null);

	React.useEffect(() => {
		const fetchStars = async () => {
			setLoading(true);
			const data = await ftch.json<{ user: Stargazer }[]>(`https://api.github.com/repos/Inrixia/TidaLuna/stargazers?per_page=100&page=${page}`, {
				headers: {
					Accept: "application/vnd.github.v3.star+json",
				},
			});
			setStars((prev) => [...prev, ...data.map(({ user }) => user)]);
			setHasMore(data.length === 100);
			setLoading(false);
		};
		if (hasMore) fetchStars();
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
		<LunaSettings title="Stargazers ⭐">
			<UserList
				users={stars.map(({ login, avatar_url, html_url }) => ({
					login,
					avatarUrl: avatar_url,
					url: html_url,
				}))}
			/>
			<div ref={loaderRef} />
			{loading && <div>Loading stargazers…</div>}
		</LunaSettings>
	);
});
