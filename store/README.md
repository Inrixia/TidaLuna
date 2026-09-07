# Plugin store registry

This is the list of plugin stores the Luna client shows in Settings > Plugin Store.
It used to live in the client source, which meant a new store needed a code change
and a client release before anyone saw it. Now the client fetches this folder from
`raw.githubusercontent.com`, so a merged pull request reaches everyone within about
five minutes with no update needed.

## Adding your store

1. Publish a release with a `store.json` asset. The Luna build does this for you,
   see the Developers section of the root README.
2. Open [store/stores.json in the GitHub editor](https://github.com/Inrixia/TidaLuna/edit/master/store/stores.json).
   GitHub creates the fork and the pull request for you, no clone needed.
3. Add your entry to the `stores` array:
   ```json
   {
   	"name": "@you/luna-plugins",
   	"repo": "you/luna-plugins",
   	"url": "https://github.com/you/luna-plugins/releases/download/latest/store.json",
   	"added": "2026-09-02"
   }
   ```
   `name` is what shows up when your store cannot be reached, use the `name` from
   your own `store.json`. `repo` is what the metrics generator queries, it has to
   match the repo in `url`.
4. Open the pull request. CI checks the schema and that your `store.json` actually
   resolves with a non empty `plugins` array, and annotates any problem right in the
   diff. Run the same checks locally with `./store/validate.sh`.

A maintainer only has to confirm that the repo is yours, then merge.

## Removing a store

Do not delete the entry. Set `"status": "removed"` with a `removed` date and a
`reason` instead:

```json
{
	"name": "Someones Plugins",
	"repo": "someone/luna-plugins",
	"url": "https://github.com/someone/luna-plugins/releases/download/latest/store.json",
	"added": "2025-11-08",
	"status": "removed",
	"removed": "2026-07-19",
	"reason": "Repo deleted, returns 404"
}
```

Deleting the line only stops new clients from picking the store up. The tombstone is
what removes it from everyone who already has it, which is why several dead stores
kept showing up as red error cards for months.

## Optional fields for plugin authors

Two fields are read from a plugin's own `package.json` and end up in its published
`<plugin>.json`. Both are optional and everything keeps working without them.

### `image` - one preview picture

```json
{
	"name": "@you/your-plugin",
	"image": "https://raw.githubusercontent.com/you/luna-plugins/master/assets/preview.png"
}
```

The store card then shows it above the text, cropped to 16:9. A card without an
`image` looks exactly as it does today.

The url must be `https` and point at one of `github.com`,
`raw.githubusercontent.com`, `user-images.githubusercontent.com` or
`objects.githubusercontent.com`. Anything else is ignored and the card falls back to
its plain form. That is not about trusting GitHub more than other hosts: the store
loads the preview of *every* listed plugin, so a free choice of host would let any
listed author collect the IP address of everyone who opens the store.

Keep the file small, a few hundred KB is plenty. It is fetched on every store view.

### `showDownloads` - opt in download counter

```json
{ "showDownloads": true }
```

Off unless you switch it on. Set it in a plugin's `package.json` for that plugin, or
once in your store repo's root `package.json` to cover every plugin in the store. A
plugin's own value wins over the store's, in both directions, so a store can enable
the counter for everything and a single plugin can still opt back out with
`"showDownloads": false`.

The number itself comes from the GitHub release asset download count that the
registry collects daily, not from anything the client reports. Nothing is sent from
a user's machine either way.

## Files

| File                 | Written by | What it is                                                                       |
| -------------------- | ---------- | -------------------------------------------------------------------------------- |
| `stores.json`        | humans     | The list. Source of truth, reviewed in pull requests.                              |
| `stores.schema.json` | humans     | Schema for `stores.json`, enforced in CI.                                          |
| `blocklist.json`     | maintainers| Kill switch. Glob patterns, matching stores disappear from every client.           |
| `registry.json`      | CI         | `stores.json` plus stars, repo health and per plugin downloads. This is what the client reads. |

`registry.json` is regenerated daily and on every change to `stores.json` by
`.github/workflows/registry.yml`. Do not edit it by hand, it will be overwritten.
Run it locally with `GITHUB_TOKEN=... node store/generate.mjs`.

## What this is not

Being listed here is not a security review. The pull request confirms once that the
repo belongs to the person submitting it. After that the same person can add any
plugin to their own `store.json` without anyone looking at it, and plugins can
request full system access. What the registry buys is accountability and a kill
switch that takes effect in minutes, not a guarantee that the code is safe.
