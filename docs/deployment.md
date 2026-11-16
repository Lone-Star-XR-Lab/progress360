# Deployment

Progress360 is a folder of static files. Any static host works (an IIS or nginx site, Netlify, Cloudflare Pages, S3 + CloudFront, GitHub Pages with a caveat below). Upload the repository contents as-is. There's no build step.

## Host requirements

| Requirement | Why |
|---|---|
| **HTTP(S), not `file://`** | ES modules, `fetch` and the service worker don't work from the file system. |
| **HTTPS** in production | Required for WebXR (VR) and for the service worker (except on `localhost`). |
| **Directory listing** (optional) | If on, the site finds new folders and dated files on its own. If off (the usual case), run `tools/sync-projects.mjs` before deploying. Turning listing on doesn't expose anything that isn't already public under `assets/`. |
| **`HEAD` requests** | Stage auto-discovery probes files with `HEAD`. If the server answers 405 or 501, images are probed with a normal image load instead, which is slower. Projects with an explicit `stages` list don't need this. |
| **`Range` requests** (recommended) | Lets the Details panel read photo EXIF data from the first 128 KB instead of downloading the whole image, and lets browsers seek in videos. Most hosts support it. |
| **Correct MIME types** | `.mjs`/`.js` → `text/javascript`, `.json` → `application/json`, `.mp4` → `video/mp4`. |
| **Outbound access to `cdn.jsdelivr.net`** | three.js is loaded from the CDN through the import map in `index.html`. For an offline or locked-down deployment, download `three.module.js` and the `examples/jsm/` files you need, and point the import map at local copies. |

Sub-folder hosting (e.g. `https://example.com/progress360/`) works, because every path in the app is relative.

## Git LFS and videos

`.mp4` files are stored with Git LFS (`.gitattributes`). Make sure the deployed files are the **real videos**, not LFS pointer files:

- Locally: `git lfs install` once, then `git lfs pull`.
- CI/CD: enable LFS on checkout (e.g. `actions/checkout` with `lfs: true`).
- **GitHub Pages doesn't serve LFS content.** It serves the small text pointer files, and the video stages show up black. Either deploy through a workflow that checks out with LFS and publishes the build output, or host the videos elsewhere and list them with absolute URLs in an explicit `stages` array.

Quick check: a real video starts with the bytes `....ftyp`. A pointer file starts with `version https://git-lfs.github.com/spec/v1`.

## Caching

The service worker (`sw.js`) caches images under `/assets/` **permanently, cache-first**:

- Adding new images: nothing to do. New URLs are fetched and cached.
- **Replacing an image in place (same file name): bump `CACHE_VERSION`** in `sw.js` (`p360-v2` → `p360-v3`). The new worker deletes the old cache when it activates. Without the bump, returning visitors keep seeing the old image.
- HTML, JS, CSS, JSON and videos aren't handled by the service worker. They follow your host's normal HTTP caching. If your host caches aggressively, set `Cache-Control: no-cache` on `index.html`, `main.js`, `viewer.js`, `styles.css`, `sw.js` and `assets/projects.json`, so updates show up right away.

To force-refresh during development: DevTools → Application → Service workers → *Update on reload*, or *Clear site data*.

## Release checklist

- [ ] `node tools/sync-projects.mjs` has been run since the last media change. Production hosts usually can't list folders, so dated files only appear once they're in `projects.json`.
- [ ] New projects have a thumbnail (`tools/generate-thumbs.ps1`).
- [ ] `assets/projects.json` is valid JSON (paste it into any JSON validator, or run `node -e "JSON.parse(require('fs').readFileSync('assets/projects.json','utf8'))"`).
- [ ] Videos are real files, not LFS pointers.
- [ ] `CACHE_VERSION` bumped if any image was replaced in place.
- [ ] Open the site over HTTPS and check: gallery loads, a project opens, stages step with ← →, a video stage plays, and `#/<id>` deep links work.
