# Progress360

Progress360 is a static website for showing how a space changes over time. Each project is a set of 360° panoramas (photos or videos), from **before** through every stage to **after**. Visitors open a project and look around in 360°. They can cross-fade between stages on a timeline, and view it in a VR headset through WebXR.

There is no build step and no backend. It's plain HTML, CSS and ES modules, with [three.js](https://threejs.org/) loaded from a CDN.

| Gallery | Viewer |
|---|---|
| ![Project gallery](docs/img/gallery.png) | ![360° viewer with timeline and details](docs/img/viewer.png) |

## Features

- **Gallery** of project cards. Each card shows a small panning animation of the panorama on hover, plus search and phase filters.
- **360° viewer** for equirectangular JPEGs and MP4 videos. Drag to look around; scroll or pinch to zoom.
- **Timeline** that cross-fades smoothly between stages, with a filmstrip for jumping straight to one, and a **Play** button that plays through every stage in a loop.
- **Faithful colour.** Images display exactly as captured. Optional exposure, contrast, midtone and saturation adjustments apply to every stage, so before and after stay comparable.
- **Hold to compare** against the original, and an **Auto** suggestion when a whole project was shot dark.
- **Details panel** with the project description and tags, the capture date and GPS from the photo's EXIF data, and site info.
- **Deep links:** `index.html#/<project-id>` opens a project directly, and the back button returns to the gallery.
- **VR mode** in WebXR-capable browsers. The controller trigger changes stage; squeeze exits.
- **Remembers per project** the last stage, view direction, zoom and adjustments, in the visitor's browser.
- **Service worker** caches panoramas, so opening a project again is instant.

## Quick start

Serve the folder over HTTP. Opening `index.html` as a file won't work, because ES modules and `fetch` need a server.

```bash
# Option A: VS Code "Live Server" (configured for port 5501 in .vscode/settings.json)
# Option B: any static server
npx --yes http-server -c-1 -p 5501 .
```

Then open <http://localhost:5501/>.

Panorama videos are stored with **Git LFS**. After cloning, run `git lfs install && git lfs pull`, otherwise the `.mp4` files are only small pointer files.

## Adding a project (short version)

1. Create `assets/<folder>/` and drop in the panoramas, named by date (`20261115_anything.jpg`) or by number (`000-<slug>.jpg`, `001-<slug>.jpg`, …). Stages are ordered by number, then by date (oldest first).
2. Run `node tools/sync-projects.mjs`. It adds new folders and dated files to [`assets/projects.json`](assets/projects.json). Then fill in the new project's `title`, `meta` and `campus`.
3. Generate card thumbnails: `powershell -File tools/generate-thumbs.ps1`.

The full guide, including the JSON schema, naming rules and image sizes, is in [docs/adding-projects.md](docs/adding-projects.md).

## Project layout

```
index.html          Page shell: gallery markup, viewer markup, icon sprite, import map
styles.css          All styling (tokens, gallery, viewer, responsive rules)
main.js             Gallery: loads projects, renders cards, search/filter, hash routing, stage discovery
viewer.js           Viewer: three.js scene, colour pipeline, timeline, adjustments, info panel, XR
stages.js           Stage file naming rules (numbered / dated), shared by the browser and tools
sw.js               Service worker: cache-first for images under /assets/
assets/
  projects.json     Project catalogue
  <project>/        000-<slug>.jpg, 001-<slug>.mp4, … plus 000-<slug>-thumb.jpg
tools/
  sync-projects.mjs     Writes stage lists / new projects into projects.json (Node, no dependencies)
  generate-thumbs.ps1   Thumbnail generator (Windows, no dependencies)
  generate-thumbs.mjs   Thumbnail generator (Node + sharp)
docs/               Documentation (start below)
```

## Documentation

| Guide | For |
|---|---|
| [Adding projects](docs/adding-projects.md) | Content editors: folders, file naming, `projects.json`, thumbnails, image specs |
| [Using the viewer](docs/viewer.md) | Everyone: controls, shortcuts, adjustments, VR, what gets remembered |
| [Architecture](docs/architecture.md) | Developers: how the code fits together, the colour pipeline, extension points |
| [Deployment](docs/deployment.md) | Hosting requirements, Git LFS, caching, HTTPS for VR |

## Browser support

Current Chrome, Edge, Firefox and Safari (desktop and mobile). The viewer needs WebGL 2. VR mode needs a WebXR browser such as Meta Quest Browser, served over HTTPS. On iPhone, full screen isn't available (Safari doesn't allow it for page elements), so that button is hidden there.
