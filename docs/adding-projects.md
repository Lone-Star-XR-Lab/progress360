# Adding projects

This guide covers everything needed to add a new project to Progress360, or update an existing one: capturing the panoramas, naming the files, describing the project, and making a thumbnail.

## 1. Capture

- **Format:** equirectangular panoramas with a **2:1** aspect ratio, which is what 360° cameras (Insta360, Ricoh Theta, GoPro Max, etc.) export by default.
- **Photos:** JPEG (`.jpg`). 5760×2880 to 8192×4096 looks sharp. Phones and headsets limit texture size (often to 4096 px wide), and three.js scales larger images down on those devices automatically. Keep files under about 15 MB each so phones load them quickly.
- **Videos:** MP4 (H.264), up to 3840×1920. The video loops, and audio is muted until the visitor turns sound on.
- **Consistency:** shoot every stage from the **same spot, height and heading**. The viewer keeps the visitor's view direction when they change stage, so matching camera positions make the before/after cross-fade line up.
- **Exposure:** the viewer shows images **exactly as captured**. Fix exposure in your camera app or editor if you can. The in-viewer adjustments are a viewing aid, not an editing tool (see [viewer.md](viewer.md#adjustments)).
- **EXIF:** leave the photo's date and GPS metadata in place. The Details panel shows the capture date and links the location to Google Maps.

## 2. Folder and file naming

Each project gets its own folder under `assets/`. Name the files either **by date** (easiest; straight from the camera) or **by number**. You can mix the two in one folder.

### Dated names (recommended)

Start the file name with the date the photo was taken, as `YYYYMMDD`. Anything can follow it:

```
assets/
  lonestar-college-tomball-c210/
    20260216_C210.jpg        ← "Feb 16, 2026"
    20261115_C210.jpg        ← "Nov 15, 2026"
    20260216_C210-thumb.jpg  ← card thumbnail (generated, see step 4)
```

- Stages are shown **oldest first** and labelled with their date (e.g. "Nov 15, 2026"). The viewer's Captured field also falls back to this date when the photo has no EXIF date (and for videos).
- Accepted forms: `20261115_anything.jpg`, `2026-11-15_anything.jpg`, `20261115.jpg`, and camera-style names with a short prefix and optional time, like `IMG_20261115_143022.jpg` or `PANO_20261115_143022.jpg`.
- Two shots on the same day are ordered by their `_HHMMSS` time if the names have one (labelled "Nov 15, 2026 · 2:30 PM"); otherwise by name ("Nov 15, 2026 (1)", "(2)").
- Dated names can't be guessed by a static web server, so **after adding dated files, run the sync script** (step 3). On Live Server, new files show up even before you sync, because Live Server lists folder contents.

### Numbered names

Three digits, a hyphen, and the project **slug**:

```
assets/
  kitchen/
    000-kitchen.jpg          ← "Start", also the default thumbnail source
    001-kitchen.jpg          ← "Stage 1"
    002-kitchen.mp4          ← "Stage 2" (stages can mix photos and videos)
    999-kitchen.jpg          ← optional: always last, labelled "Current"
    000-kitchen-thumb.jpg    ← card thumbnail (generated, see step 4)
```

- The **slug** in the file names must match the project's `slug` in `projects.json`, lower-case. The folder name can be anything (for example `assets/lone-star-college-tomball-ric/` holds `000-ric.jpg`).
- If a folder contains **only** `000`–`039` (and `999`) numbered files, no sync is needed: the browser finds them by itself. It checks four numbers at a time and stops at the first group of four with no files, so don't leave gaps of four or more.
- If both `NNN-slug.jpg` and `NNN-slug.mp4` exist, the `.jpg` wins.

### Mixing, and the full order

Within a folder, stages are ordered: **numbered** (by number) → **dated** (oldest first) → **any other media file** (by name, labelled from the file name) → **`999-…`** ("Current"). So `000-ric.jpg` + `20261115_e253.jpg` shows as *Start → Nov 15, 2026*. Files ending in `-thumb.jpg` are ignored. These rules live in [`stages.js`](../stages.js).

To use your own labels (for example "Demolition", "Framing", "Finished") or a different order, write the `stages` list by hand (see below).

## 3. Describe the project in `assets/projects.json`

### Let the sync script do the bookkeeping

```bash
node tools/sync-projects.mjs --dry   # preview
node tools/sync-projects.mjs         # write assets/projects.json
```

It needs only Node (no `npm install`). It:

- writes a `stages` list (marked `"autoStages": true`) for every folder whose files the browser can't guess, such as dated names, and regenerates those lists on every run;
- leaves hand-written `stages` lists (no `autoStages`) alone;
- adds a new entry for any folder under `assets/` that has media but no project yet. **Edit its `title`, `meta` and `campus` afterwards**; its `id` (the link `#/<id>`) is the folder name, which you may want to shorten;
- moves `meta.updated` forward to the newest dated stage;
- warns about projects whose folder no longer exists.

Run it again whenever you add, rename or remove dated files.

### Or write the entry yourself

Add an object to the `projects` array. Every field except `id`, `title` and `folder` is optional, but the more you fill in, the better the card and Details panel look.

```json
{
  "id": "kitchen",
  "title": "Kitchen",
  "folder": "assets/kitchen",
  "slug": "kitchen",
  "thumb": "assets/kitchen/000-kitchen.jpg",
  "meta": {
    "location": "Kitchen",
    "phase": "In Progress",
    "updated": "2025-09-28",
    "description": "Kitchen modernization highlighting new cabinetry, lighting, and expanded prep space."
  },
  "campus": {
    "campus": "Private",
    "building": "",
    "room": ""
  },
  "tags": ["remodel"]
}
```

| Field | Required | Used for |
|---|---|---|
| `id` | yes | Unique key. Becomes the deep link (`index.html#/kitchen`) and the key for the visitor's saved settings. **Changing it resets everyone's saved view and adjustments for that project.** |
| `title` | yes | Card title and viewer heading. |
| `folder` | yes | Path to the project folder, relative to the site root. |
| `slug` | recommended | The name used in the media file names. Defaults to `id` with any characters other than letters and numbers turned into `-`. |
| `thumb` | no | Fallback thumbnail if `000-<slug>-thumb.jpg` doesn't exist. |
| `meta.location` | no | Shown on the card and as the Location when the photo has no GPS. |
| `meta.phase` | no | Free text. `Planning`, `In Progress` and `Completed` get coloured badges, appear in that order in the filter chips, and are recommended. |
| `meta.updated` | no | `YYYY-MM-DD`. Shown as "Updated Oct 20, 2025". |
| `meta.description` | no | Card blurb (two lines) and the About panel (full text). |
| `campus.campus`, `.building`, `.room` | no | Joined into the "Site" line, e.g. *Lone Star College – Tomball · E Building · E251*. Empty strings are skipped. |
| `tags` | no | Shown as `#tags` in the About panel. Searchable. |
| `stages` | no | Explicit stage list (see below). Skips auto-discovery. |
| `autoStages` | no | Set by `tools/sync-projects.mjs` on lists it generated. Remove it if you hand-edit that list, so the script stops regenerating it. |

The search box matches title, description, location, phase, campus/building/room and tags.

### Explicit stages (custom labels or file names)

When `stages` is present, the viewer uses it in the order written and doesn't look for other files. Relative `url`s are resolved against `folder`. Full URLs (`https://…`) and site-absolute paths (`/media/…`) are used as-is. `label` is optional: without it, a stage gets the automatic label from its file name (a date, "Start", "Stage 1", …).

```json
{
  "id": "deck",
  "title": "Deck",
  "folder": "assets/deck",
  "stages": [
    { "label": "Before",       "url": "000-deck.jpg" },
    { "label": "New boards",   "url": "001-deck.jpg" },
    { "label": "Lights on",    "url": "002-deck.mp4" }
  ]
}
```

This also suits large projects, because it avoids the extra discovery requests.

## 4. Thumbnails

Cards load a small thumbnail (about 1200 px wide) of the **first stage** instead of the full panorama: `000-kitchen.jpg` → `000-kitchen-thumb.jpg`, `20260216_C210.jpg` → `20260216_C210-thumb.jpg`. Generate it with either script. Both skip thumbnails that already exist:

```powershell
# Windows, no dependencies
powershell -ExecutionPolicy Bypass -File tools/generate-thumbs.ps1
#   -Width 1200 -Quality 74 -WhatIf   (optional)
```

```bash
# Node (any OS); needs sharp
npm i --no-save sharp
node tools/generate-thumbs.mjs            # all folders under assets/
node tools/generate-thumbs.mjs assets/kitchen
#   THUMB_WIDTH=1200 THUMB_QUALITY=74, --dry for a dry run
```

To **regenerate** a thumbnail (for example after replacing the first image, or adding an older dated image that becomes the new first stage), delete the old `-thumb.jpg` first.

If there's no thumbnail, the card falls back to `thumb` and then to the first stage image itself. It still works, but the gallery loads much more data.

## 5. Check it

1. Start a local server (see the [README](../README.md#quick-start)) and reload the page.
2. The card should appear with the right thumbnail and, after a moment, the stage count ("3 stages") and a **Video** badge if any stage is an MP4.
3. Open it and step through each stage with ← →.

## 6. Commit

- `.mp4` files are tracked by **Git LFS** (see `.gitattributes`). Run `git lfs install` once per machine before committing videos.
- If you **replace** an image but keep the same file name, bump `CACHE_VERSION` in `sw.js` (e.g. `p360-v2` → `p360-v3`). Otherwise returning visitors keep seeing the cached old image. See [deployment.md](deployment.md#caching).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Card shows "No preview" | No `000-<slug>-thumb.jpg`, no `thumb`, and no `000-<slug>.jpg`. Check the slug spelling and case. |
| Viewer says "No media found for this project." | The folder path is wrong, or the files are dated/other names and `tools/sync-projects.mjs` hasn't been run. |
| A new dated photo shows locally but not on the live site | Run `node tools/sync-projects.mjs` and commit `projects.json`. Live Server lists folders; most hosts don't. |
| A stage is missing | Not synced (see above), a gap of four or more numbers, or a number above `039`. |
| A dated file is in the wrong place or has a filename label | The date part isn't at the start of the name (or after a short prefix like `IMG_`), or it isn't a real date. |
| Video stage is black | Not H.264 MP4, or the repo has only the LFS pointer (`git lfs pull`). |
| Image looks dark or flat | That is how it was captured. Fix it in the source, or use the viewer's Auto/Exposure. Adjustments are saved per browser, not for everyone. |
| Old image still shows after replacing it | Service worker cache: bump `CACHE_VERSION` in `sw.js`. |
