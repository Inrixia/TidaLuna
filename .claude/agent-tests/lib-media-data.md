# @luna/lib reads real media data

Requires: login

`MediaItem`, `Album`, `Artist`, `Playlist` and `TidalApi` in `plugins/lib/src/classes` fetch from TIDAL's API and Redux store. Check them against the real API. Do not start playback.

1. `start` (copies the login from the daily client).
2. Pick a well known track id (for example from the home page: `eval` the Redux store's `content.mediaItems` or navigate to an album with `router/PUSH`).
3. `eval 'luna.lib.MediaItem.fromId(<id>).then(async (m) => ({ title: await m?.title(), artist: (await m?.artist())?.name, album: await (await m?.album())?.title(), isrc: await m?.isrc(), duration: m?.duration }))'`, adapting to the class's current methods (read `MediaItem.ts`).
4. Do the same for the album and artist (`Album.fromId`, `Artist.fromId`), and `TidalApi` calls that read metadata (read `TidalApi` for which ones).
5. Check lyrics and playback info (`MediaItem.lyrics()`, `playbackInfo()` or whatever exists) only if they work without playing.

Pass when the calls return the same title/artist/album TIDAL shows for that item and none throw. Report any method that returns `undefined` where TIDAL has the data.
