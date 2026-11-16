# Deployment

Progress360 is a folder of static files. Any static host works (an IIS or nginx site, Netlify, Cloudflare Pages, S3 + CloudFront, or GitHub Pages through the included workflow). Upload the repository contents as-is. There's no build step. `node_modules/`, `tests/`, `tools/`, `docs/` and `.github/` aren't needed on the server.

## Host requirements

| Requirement | Why |
|---|---|
| **HTTP(S), not `file://`** | ES modules, `fetch` and the service worker don't work from the file system. |
| **HTTPS** in production | Required for WebXR (VR) and for the service worker (except on `localhost`). |
| **Directory listing** (optional) | If on, the site finds new folders and dated files on its own. If off (the usual case), run `tools/sync-projects.mjs` before deploying. Turning listing on doesn't expose anything that isn't already public under `assets/`. |
| **`HEAD` requests** | Stage auto-discovery probes files with `HEAD`. If the server answers 405 or 501, images are probed with a normal image load instead, which is slower. Projects with an explicit `stages` list don't need this. |
| **`Range` requests** (recommended) | Lets the Details panel read photo EXIF data from the first 128 KB instead of downloading the whole image, and lets browsers seek in videos. Most hosts support it. |
| **Correct MIME types** | `.mjs`/`.js` → `text/javascript`, `.json` → `application/json`, `.mp4` → `video/mp4`. |
| **Outbound access to `tile.openstreetmap.org`** (visitors only) | Map view tiles. Everything else, including three.js and Leaflet, is served from `vendor/`, so no CDN is needed. Without tile access the map still shows pins on a blank background. For heavy traffic, consider your own tile provider ([OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)); change the URL in `renderMap()` in `main.js`. |

Sub-folder hosting (e.g. `https://example.com/progress360/`) works, because every path in the app is relative.

## Git LFS and videos

`.mp4` files are stored with Git LFS (`.gitattributes`). Make sure the deployed files are the **real videos**, not LFS pointer files:

- Locally: `git lfs install` once, then `git lfs pull`.
- CI/CD: enable LFS on checkout (e.g. `actions/checkout` with `lfs: true`).
- **GitHub Pages doesn't serve LFS content** when it publishes straight from a branch. It serves the small text pointer files, and the video stages show up black. Use the included workflow (below), which checks out with LFS and publishes the real files, or host the videos elsewhere and list them with absolute URLs in an explicit `stages` array.

Quick check: a real video starts with the bytes `....ftyp`. A pointer file starts with `version https://git-lfs.github.com/spec/v1`.

## GitHub Pages and CI

`.github/workflows/ci.yml` runs on every push and pull request:

1. checks out with **LFS**, installs `playwright-core`;
2. `npm run check`: `projects.json` must be in sync with `assets/` and free of errors;
3. `npm test`: smoke tests in headless Chrome (preinstalled on GitHub's Ubuntu runners).

To **deploy to GitHub Pages** from `main` after the tests pass:

1. Settings → Pages → *Build and deployment* → Source: **GitHub Actions**.
2. Settings → Secrets and variables → Actions → *Variables* → new repository variable **`DEPLOY_PAGES`** = `true`.
3. Push to `main` (or run the workflow by hand). The site appears at `https://<org>.github.io/<repo>/`.

The deploy job copies only the files the site needs into `_site/`. **Size limits:** a GitHub Pages site can be at most 1 GB, and LFS downloads in Actions count against the organisation's LFS bandwidth quota. The panoramas are already over 800 MB. Once you get close to the limit, move the media to another host (or a Pages-adjacent bucket/CDN) and list it with absolute URLs in explicit `stages` arrays.

## Caching

The service worker (`sw.js`) handles two kinds of request:

- **Panoramas under `/assets/`** (`.jpg .jpeg .png .webp .avif`, including `-thumb` and `-4k` copies): **cache-first, permanently.**
  - Adding new images: nothing to do. New URLs are fetched and cached.
  - **Replacing an image in place (same file name): bump `CACHE_VERSION`** in `sw.js` (`p360-v3` → `p360-v4`). The new worker deletes the old caches when it activates. Without the bump, returning visitors keep seeing the old image.
- **The app shell** (the page, JS, CSS, `projects.json`, the manifest, icons, `vendor/`): **network-first**. Visitors always get the latest version when online, and the cached copy when offline, so the installed app still opens. No version bump is needed for code or catalogue changes.
- Videos and `Range` requests aren't handled by the service worker.

If your host caches aggressively, set `Cache-Control: no-cache` on `index.html`, `main.js`, `viewer.js`, `styles.css`, `sw.js` and `assets/projects.json`, so updates show up right away.

To force-refresh during development: DevTools → Application → Service workers → *Update on reload*, or *Clear site data*.

## Release checklist

- [ ] `npm run check` passes (it also catches invalid JSON). Production hosts usually can't list folders, so dated files only appear once `npm run sync` has put them in `projects.json`.
- [ ] New images have a thumbnail and 4K copies (`tools/generate-thumbs.ps1`).
- [ ] `npm test` passes.
- [ ] Videos are real files, not LFS pointers.
- [ ] `CACHE_VERSION` bumped if any image was replaced in place.
- [ ] Open the site over HTTPS and check: gallery loads, a project opens, stages step with ← →, a video stage plays, and `#/<id>` deep links work.
