# Montage editor — status and next steps


## Goal ("CapCut on steroids")
1. Talk about the video (story/script) in chat.
2. Pick content (local folders or Google Photos — `lib/google_photos.py`).
3. Claude proposes the clip order -> `projects/<id>/artifacts/timeline.json`.
4. You edit it in the CapCut-style editor (order, trims, text, music, transitions).
5. Claude adds animated "motion scenes" (HyperFrames) as clips on the timeline.
6. Export the final MP4 only when it is good.

## Done
- `schemas/artifacts/timeline.schema.json`, `lib/timeline.py`: one file = the whole edit.
- `remotion-composer/src/montage/`: reusable `FamilyMontage` composition (transitions, motion,
  grades, text incl. Hebrew RTL, music fades + ducking, Brand opener).
- `scripts/render_timeline.py <project> [--preview] [--draft]`: render a timeline.
- Editor: `python -m backlot edit <project>` -> http://127.0.0.1:4750/e/<project>
  (`backlot/editor_api.py`, `backlot/ui/editor.html`, `backlot/ui/editor/*`).
  Preview player bundle: `cd remotion-composer && npm run build:editor` after changing `src/montage/*`.
- Test project: `projects/trip-with-a-friend/artifacts/timeline.json` (12 clips).

## Done: HyperFrames motion scenes
- Templates in `motion_templates/<id>/` (`index.html` + `template.json`; shared gsap/motion-kit/base.css in
  `_shared/`): `title-card`, `chapter-card`, `photo-collage` (2-4 photos + caption), `outro`.
  Placeholders `__W__`, `__H__`, `__DUR__` are filled per scene; text/colors/photos are HyperFrames variables.
- `lib/motion_scenes.py`: `list_templates`, `create_scene` (workspace in `projects/<id>/motion/<scene-id>/`),
  `check_scene` (`hyperframes lint`; only errors block), `snapshot_scene`, `render_scene`
  (-> `public/motion/<scene-id>.mp4`, returns a timeline clip with a `generated` field).
- `clip.generated` ({engine, scene, template, params}) is in the schema, so a scene can be edited and re-rendered.
- API: `GET /api/editor/<id>/motion/templates`, `POST|GET /api/editor/<id>/motion/render`.
- Editor: "Motion" tab in the media bin (template form -> Create & render -> clip inserted), and a
  "Motion scene" form with "Re-render scene" in the inspector of a generated clip.
- `/media/...` now sends `Cache-Control: no-cache` so a re-rendered scene is never stale in the preview.

Notes / gotchas
- `hyperframes snapshot` ignores the variables file (shows template defaults) — to check real text/photos,
  render with `--quality draft` and look at frames.
- Lint rules that bit us: no animating `letterSpacing`; every font in `base.css` must be one HyperFrames can
  resolve (Heebo only — it covers Hebrew).
- `python -m backlot edit` only attaches to a running `backlot serve`; restart that process after changing Python.

## Done: start from the root URL (http://127.0.0.1:4750/)
- Library cards open the editor ("Edit montage" / "Start montage"); "Board" is a small link. "＋ New montage" makes a project.
- Editor header: ← Library, project switcher, Board link.
- "＋ Import" (bin) / empty state: import from the project's `source-media`, any folder on this Mac, or the
  Google Photos picker (needs a native Mac server; it opens a browser tab). Files are hard-linked into `public/media`.
- API: `POST /api/editor/projects`, `GET /{id}/sources`, `POST /{id}/import`, `POST|GET /{id}/google-photos`.

## Next after that
Real beats from the song (`hyperframes beats` or librosa) + snap cuts, near-duplicate photo removal,
best-moment picking for videos, Google Photos picker in the media bin.

## Notes
- The Remotion player preview loads Google Fonts (needs internet).
- Final export: CRF 16, JPEG quality 95, x264 slow. Preview: half size.
