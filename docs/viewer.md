# Using the viewer

Open any project card (or a link like `index.html#/commons`) to enter the 360° viewer.

![Viewer on a phone](img/viewer-phone.png)

## Layout

- **Top bar:** back arrow, project title, current stage ("Stage 1 · 2 of 4") and loading progress. On the right: **Sound** (only for projects with video), **Recenter**, **Full screen**, and the **Details** panel toggle.
- **View:** the panorama itself. Drag to look around; scroll the mouse wheel or pinch to zoom.
- **Timeline:** the slider cross-fades continuously between stages. Let go and it settles on the nearest stage. **‹ ›** step one stage at a time with a short animated fade. The **filmstrip** below shows every stage; click one to jump to it.
- **Play** (the teal button at the left of the timeline, or **Space**/**P**) plays through the stages in order: Start → Stage 1 → Stage 2 … It dissolves slowly between them (4 s), holds on each one (3 s, shown as a bar filling under the current filmstrip item), and after the last stage fades straight back to Start and keeps looping. You can keep dragging to look around while it plays. Using the slider, ‹ ›, the filmstrip, Home or End stops playback. Stages that are still loading are waited for; stages that failed to load are skipped. Change the timing with `PLAY_FADE_MS` and `PLAY_HOLD_MS` at the top of `viewer.js`.
- **Details panel:** the About, Details, Adjustments and Shortcuts sections. On wide screens it's a sidebar that you can hide. On screens 960 px wide or narrower it slides over the view, and it starts closed.

In **full screen**, the timeline floats over the image so you can keep changing stages.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Space / P | Play / pause through the stages (Space works when no button has focus; P always works) |
| ← / → | Previous / next stage |
| Home / End | First / last stage |
| F | Full screen on/off |
| R | Recenter view (and reset zoom) |
| + / − | Zoom in / out |
| C (hold) | Show the original, without adjustments |
| I | Show/hide the Details panel |
| M | Sound on/off (video stages) |
| Esc | Exit VR, exit full screen, close the slide-over panel (narrow screens), or go back to the gallery, whichever applies first |

## Details panel

- **About:** the project description and tags from `projects.json`.
- **Stage:** label and position.
- **Captured:** from the photo's EXIF `DateTimeOriginal`. If the photo has none, it falls back to the file's `Last-Modified` date from the server. Videos show "—".
- **Location:** if the photo has GPS EXIF data, a link to Google Maps; otherwise `meta.location`.
- **Site, Phase, Updated, Media:** from `projects.json` and the stage list.

## Adjustments

Images start **exactly as captured**: with every slider at 0, the screen shows the source pixels unchanged. The adjustments let a viewer compensate for a dark or flat capture without editing files.

| Control | Range | What it does |
|---|---|---|
| **Exposure** | −2 to +2 EV | Brightens or darkens like a camera exposure change, applied in linear light. +1 EV doubles the light. Highlights can clip at high values. |
| **Contrast** | −50 to +50 | Spreads tones away from (or toward) middle grey. |
| **Midtones** | −50 to +50 | Lifts or lowers the middle tones while leaving pure black and white where they are, like the middle slider in a Levels tool. Good for opening up shadows without blowing out windows. |
| **Saturation** | −100 to +100 | −100 is black and white; +100 doubles colour intensity. |

- **Applies to every stage of the project.** Before and after are always shown with the same treatment, so the comparison stays fair.
- **Auto** samples every loaded stage (ignoring the stretched floor and ceiling areas) and suggests an exposure that brings the average to a natural middle grey, plus a small contrast lift if the images are flat. It's deliberately gentle and only runs when you click it.
- **Hold to compare** (or hold **C**) temporarily shows the original.
- **Reset** returns every slider to 0. **Double-click** a single slider to reset just that one.
- The badge next to the heading reads **Original** or **Adjusted**.

Adjustments are stored **in your browser only**. They aren't shared with other visitors and don't change the files.

## What gets remembered

For each project, the browser stores the last stage, view direction, zoom and adjustments in `localStorage`, under the key `p360:v2:<project id>`. It also remembers whether you hid the details sidebar, and whether you've seen the "drag to look around" hint.

To clear it, use your browser's site data settings, or run `localStorage.clear()` in the dev tools console.

> The `v2` prefix was introduced with the colour-pipeline fix. Settings saved by older versions were tuned to compensate for the old too-dark rendering, so they're intentionally ignored.

## Video stages

- Videos loop and start muted, because browsers block autoplay with sound. The **Sound** button pulses gently when the current stage has audio. Click it (or press **M**) to turn sound on.
- Only the current stage's video plays sound. During a cross-fade, both videos involved play.
- Leaving the viewer pauses every video.

## VR (WebXR)

On a headset browser that supports WebXR (e.g. Meta Quest Browser), an **ENTER VR** button appears in the bottom-right corner of the view. The page must be served over **HTTPS**.

| Controller | Action |
|---|---|
| Trigger on the first controller (WebXR controller 0, usually the right hand) | Next stage |
| Trigger on the second controller (controller 1) | Previous stage |
| Squeeze (either) | Exit VR |

Adjustments made before entering VR carry over.

## Sharing a project

The URL updates as you open projects, for example `https://example.com/progress360/#/ric`. Share it to link straight to that project. **Back** in the browser (or the arrow in the top bar) returns to the gallery.
