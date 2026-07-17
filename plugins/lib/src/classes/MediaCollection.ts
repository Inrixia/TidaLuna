import { MediaItem } from "./MediaItem";

export interface MediaCollection {
	/**
	 * The number of `mediaItems` in the collection.
	 */
	count(): Promise<number>;
	mediaItems(): Promise<AsyncGenerator<MediaItem, unknown, unknown>>;
	title(): Promise<string | undefined>;
}
