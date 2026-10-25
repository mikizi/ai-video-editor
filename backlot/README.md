# Backlot — the living storyboard

A read-only local board that shows a production happening: pipeline stages
lighting up, the script as a screenplay page, the scene plan as a filmstrip
that fills in as assets generate, decisions, spend, and activity — all
derived from what the pipeline already writes to `projects/<id>/`.

```bash
python -m backlot open <project-id>   # start server if needed + open browser
python -m backlot open                # library view (all projects)
python -m backlot serve --port 4750   # run the server in the foreground
```

## How it stays live

No agent involvement. A `watchfiles` watcher on `projects/` publishes change
notifications over SSE; the browser refetches board state. State sources:

| Board element | Disk source |
|---|---|
| identity / rail order | `project.json` + `pipeline_defs/<type>.yaml` |
| stage states, gates, versions | `checkpoint_<stage>.json` + `history/` |
| script card / modal | `artifacts/script.json` |
| filmstrip cards | `scene_plan × script × asset_manifest` join |
| generating shimmer, activity | `events.jsonl` (written by `BaseTool` instrumentation) |
| cost meter | checkpoint `cost_snapshot` |
| renders | `renders/*.mp4` (+ root-level mp4 heuristic) |

Projects without checkpoints degrade gracefully to a "what the watcher
found" view — media, snapshots, renders.

**Replay**: a completed run can be scrubbed end-to-end (▶ REPLAY RUN on the
board) — reconstructed from checkpoint history and event timestamps.

Try it without a real production:

```bash
python scripts/backlot_simulate_run.py          # live demo run (~1 min)
python -m backlot open backlot-demo-run
```

Design doc: `internal/design/LIVING_STORYBOARD.md`.

## Timeline editor (CapCut-style)

```bash
python -m backlot edit <project-id>   # opens http://127.0.0.1:4750/e/<project-id>
```

Edits `projects/<id>/artifacts/timeline.json` (see `schemas/artifacts/timeline.schema.json`)
with a live preview that runs the same `FamilyMontage` Remotion composition as the
final render. Media comes from `projects/<id>/public/`.

- Media bin: click a photo/video to add it after the selected clip, or drag it onto the
  video track. Click a song to set the music.
- Timeline: drag clips to reorder, drag clip edges to trim, click a ◆ to change the
  transition, `S` splits at the playhead, `⌫` deletes, `⌘Z` / `⇧⌘Z` undo/redo.
- Inspector: trim, speed, clip sound, transition, motion, fit/focus, text, music, style.
- Autosaves. If Claude edits `timeline.json` at the same time, the editor reloads it
  (or asks which version to keep when you also have unsaved edits).
- "Preview render" (half size, fast) and "Export MP4" (full quality) run
  `scripts/render_timeline.py` and link the result.

The preview player is a prebuilt bundle (`ui/editor/montage-player.js`). After changing
`remotion-composer/src/montage/*`, rebuild it: `cd remotion-composer && npm run build:editor`.
This is the only Backlot page that writes to a project (only `timeline.json`).
