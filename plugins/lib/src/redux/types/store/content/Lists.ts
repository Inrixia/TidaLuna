export interface List {
	currentDirection?: string | null;
	currentOrder?: string | null;
	dataApiPath?: string /** @example "users/54959548/favorites/albums" */;
	entityId?: string;
	entityItemsType?: string /** @example "album" */;
	entityType?: string /** @example "albumList" */;
	sorted: ListSorted;
	totalNumberOfItems: number;
}

export interface ListSorted {
	defaultSort: ListSortState;
	DATE_DESC?: ListSortState;
}

export interface ListSortState<T = number | string> {
	cursor?: string | null;
	isFullyLoaded: boolean;
	items: T[];
	loading: boolean;
	offset?: number | null;
}
