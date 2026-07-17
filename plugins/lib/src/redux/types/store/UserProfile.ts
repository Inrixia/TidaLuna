type ProfileColor = [string, string, string];

export type UserFollowType = "USER" | "ARTIST";
export interface Following {
	id: number;
	color: ProfileColor;
	name: string;
	picture?: string | null;
	imFollowing: boolean;
	blocked: boolean;
	trn: `trn:user:${string}`;
	followType: UserFollowType;
}

export type UserProfileDataTypes = "artists" | "followers" | "publicPlaylists" | "users";

export interface UserProfile {
	color: ProfileColor;
	followers: {
		items: Following[];
	};
	followingArtists: {
		items: Following[];
	};
	followingUsers: {
		items: Following[];
	};
	name: string;
	numberOfFollowers: number;
	numberOfFollows: number;
	picture?: string | null;
	publicPlaylists: {
		items: {
			itemId: string;
			itemType: "playlist";
		}[];
	};
	state: string;
	userId: number;
}
