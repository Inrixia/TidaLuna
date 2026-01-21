import type { Tracer } from "@luna/core";

import { libTrace } from "../index.safe";
import { ContentBase, type TCoverRes } from "./ContentBase";
import { TidalApi } from "./TidalApi";

import type * as redux from "../redux";

export class Artist extends ContentBase {
	constructor(
		public readonly id: redux.ItemId,
		public readonly tidalArtist: redux.Artist,
	) {
		super();
	}

	public static readonly trace: Tracer = libTrace.withSource(".Artist").trace;

	public static async fromId(artistId?: redux.ItemId): Promise<Artist | undefined> {
		if (artistId === undefined) return;
		return super.fromStore(artistId, "artists", async (artist) => {
			artist = artist ??= await TidalApi.artist(artistId);
			if (artist === undefined) return;
			return new Artist(artistId, artist);
		});
	}

	public coverUrl(res?: TCoverRes) {
		if (this.tidalArtist.picture === undefined) return;
		return ContentBase.formatCoverUrl(this.tidalArtist.picture, { res });
	}

	public get name() {
		return this.tidalArtist.name;
	}
}
