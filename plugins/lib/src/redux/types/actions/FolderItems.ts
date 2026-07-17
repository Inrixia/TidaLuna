import type { FolderItem } from "neptune-types/tidal";

import type { ItemId } from "../store";
import type { SortDirection, SortOrder } from "./SortOrders";

export type FolderItemContext = "all" | "folder" | "page" | "sidebar";

interface FolderItems {
	context: FolderItemContext;
	contextId?: ItemId;
	poll?: boolean | null;
	reset?: boolean | null;
	sortDirection?: SortDirection | null;
	sortOrder?: SortOrder | null;
}
export interface LoadFolderItemsPayload extends FolderItems {
	cacheCheck?: boolean;

	failSilently?: boolean | null;
	flatten?: boolean;
	includeOnly?: string;
	loadAll?: boolean;
}

export interface LoadFolderItemsSuccess extends FolderItems {
	cursor?: string | null;
	eTag?: string | null;
	folderItems: FolderItem[];
	totalNumberOfItems: number;
}

export interface LoadSpecificFolderItemsSuccess extends FolderItems {
	cursor?: string | null;
	eTag?: string | null;
	folderItems: FolderItem[];
	includeOnly?: string;
	totalNumberOfItems: number;
}
