import type { Image } from ".";

export type ArticleLink = `https://tidal.com/magazine/article/${string}/${string}`;

export interface Article {
	title: string;
	link: ArticleLink /** @example "https://tidal.com/magazine/article/msw-june-2022/1-85743" */;
	date: string /** @example "2022-06-29T15:47:09Z" */;
	images: {
		original: Image;
		large: Image;
		medium: Image;
	};
	contentType: "article";
	id: ArticleLink /** @example "https://tidal.com/magazine/article/msw-june-2022/1-85743" */;
}
