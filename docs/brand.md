# Brand assets

Logos, icons and artwork for TidaLuna. Everything in `assets/brand/` is the master copy; the app inlines the files it
needs at build time, so a Luna install is still just the files esbuild wrote.

## Where each one is used

| Asset | Used by |
| --- | --- |
| `splash-screen.svg` | Boot splash, `render/src/loadingContainer.ts` via `render/src/exposeTidalInternals.ts`. Inlined with `file://` and shown as a full-window background until TIDAL's app mounts. |
| `app-icon-256.png` | Window and taskbar icon on Windows and Linux, dock icon on macOS: `native/appIcon.ts`, used by `native/injector.ts`. |
| `client-header.svg` | TIDAL's title bar, `plugins/lib/src/windowTitle.ts`: the wordmark and its BETA pill replace TIDAL's own wordmark. Its viewBox is cropped to the artwork's ink and its BETA pill is scaled up inside the artwork, so both read at the ~26px the title bar gives the image instead of shrinking to nothing. |
| `github-banner.svg` | README header. The SVG keeps it crisp at any width. |
| `github-banner.png` | The same banner at 1280x427 for the GitHub repository banner setting, which takes a raster. Rendered from the SVG by drawing it on a canvas, so the file is artwork only and has no page background around it. |
| `logo-dark.svg`, `logo-light.svg` | Wordmark for dark and light backgrounds, for docs and pages outside the client. |
| `emblem.svg`, `emblem-monochrome.svg` | The mark on its own, for docs, avatars and places that need a `currentColor` version. |
| `app-icon.svg`, `app-icon-1024.png`, `app-icon.ico` | Icon source, the Luna settings version card (`LunaVersionInfo.tsx`), store listing artwork, and the Windows `.ico` for installers and shortcuts. `app-icon-256.png` is cropped from the 1024 to the artwork's edge, because a transparent margin inside the icon makes Windows draw the taskbar and title bar icon smaller than every icon next to it. |
| `social-preview.png`, `social-preview.svg` | GitHub social preview and Open Graph image. Set by hand in the repository settings. |

## Constraints

- The splash is opaque and covers the window, so it must never take a click: `render/src/loadingContainer.ts` sets
  `pointer-events: none` and `render/src/loadingContainer.test.ts` asserts it.
- The splash is sized from the artwork's 16:9 ratio against the window, and fades out over `splashFadeMs` instead of
  cutting. The fade is a transition declared in the splash stylesheet, because a transition set in the same style write
  as the value it animates never runs.
- Three blurred gradient blobs drift along the window edges for movement, kept clear of the middle so the wordmark sits on
  the background it was drawn on, at low opacity to match TIDAL's own background wash. Every animation is transform-only:
  animating a filter on a full-window blur repaints it every frame, which flickers while TIDAL is still booting. Motion is
  off under `prefers-reduced-motion`.
- The artwork in the client is the white wordmark on purpose: it goes on TIDAL's own title bar, which is dark. Nothing else
  in the settings page is branded beyond the version card, which uses the app icon, so a theme that turns the page light
  has nothing of ours to wash out.
- Rasters are only kept where a format is required (`.ico` for Windows, PNG for GitHub and stores). Prefer the SVG.

## Licence

The artwork here is by DukeVenator. Credit him and use it for whatever you like, the whole licence is in
`assets/brand/LICENSE.md`.

## How an asset is inlined

`import base64 from "file://../../assets/brand/emblem.svg?base64"` is turned into a base64 string at build time by
`build/plugins/fileUrl.ts`, for the render bundle, the plugin bundles and both native bundles. Tests get the same
behaviour from `test/viteFileUrlAssets.ts`, so a module that inlines artwork can still be unit tested.
