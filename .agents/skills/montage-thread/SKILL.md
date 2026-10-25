---
name: montage-thread
description: Build and revise a montage video (family trip, event recap, highlight reel) entirely from chat, with the Backlot editor open beside it for final touch-ups. Use when the user wants to make or change a montage video, pick content, order clips, add titles/chapter cards/photo collages/outro, sync cuts to the song, or render it; when they mention the editor at http://127.0.0.1:4750/, "the timeline", "motion scenes" or "beats"; or when they say $montage-thread.
---

# Montage thread

The video is made **in the conversation**. The Backlot editor (http://127.0.0.1:4750/) is always running in the user's browser and
**live-updates whenever `projects/<id>/artifacts/timeline.json` changes** - so every command below shows up there at once.
The user uses the UI only for final touch-ups (trim, text, order). Do not ask them to click through the UI to do something you can do with a command.

Read `AGENT_GUIDE.md` first (pipeline rules still apply to full productions; this skill covers the montage timeline workflow in `docs/montage-editor.md`).

## Start of a thread
1. **You start the editor yourself - never ask the user to.** The moment work on a project begins, check it is up and, if not, start it for that project (the user does not run servers): `curl -s localhost:4750/api/health`. If not: `.venv/bin/python -m backlot edit <project>` (run it in the background and leave it running). After changing Python code in `backlot/`, restart the `backlot serve` process (`pkill -f "backlot serve"`, then run `edit` again).
2. Talk about the story first: who/what/where, length, vertical or wide, mood, song. Then act.
3. Project: `python scripts/montage.py new "<title>"` (or use an existing one, see `ls projects`).

## Commands (all through `scripts/montage.py`, use `.venv/bin/python`)
| Goal | Command |
|---|---|
| Bring in content | `import <project> <folder>` (copies/links photos+videos into `public/media`). Google Photos: `make import-google-photos PROJECT=<id>` (user picks in a browser tab; works only in a native Mac shell), then `import` the new `source-media/google-photos/picker-*` folder. |
| First timeline | `draft <project> [--aspect 9:16\|16:9\|1:1\|4:5]` |
| See the edit | `show <project>` (ids, order, times, text, scenes) |
| Change a clip | `patch <project> <clip-id> '{"transition":{"type":"zoom"},"text":{"value":"Hi","style":"pop"}}'` (deep merge; `null` removes a key) |
| Reorder / remove | `move <project> <clip-id> <index>` / `remove <project> <clip-id>` |
| Animated scenes | `templates`, then `scene <project> <template> --set key=value ... [--seconds N] [--after CLIP_ID \| --at INDEX] [--id SCENE_ID]`. Same `--id` again = edit and re-render that scene. Photo fields take a path relative to `public/` (e.g. `media/IMG_1.jpg`). |
| Sync to the song | `beats <project> [--snap] [--tolerance 0.4]` (detects beats with HyperFrames, cached; `--snap` moves cut points onto beats) |
| Export | `render <project> --preview` (fast, half size) then `render <project>` only when the user says it is good |

Clip fields you can patch: `in`/`out` (video trim, seconds), `hold` (photo seconds), `speed`, `volume`, `fit`, `focus {x,y}`, `motion`
(none, punch, zoom-in, zoom-out, pan-left, pan-right), `transition {type, seconds}` (cut, fade, flash, zoom, slide-left, slide-up, whip, dip-black),
`text {value, position, style}`. Project-level things (style, music, opener, texts) live in `timeline.json` - edit the file with
`lib.timeline.load/save` (validates) rather than raw writes. Schema: `schemas/artifacts/timeline.schema.json`.

## Review notes (code review for the film)
The user pins notes on the timeline in the editor (💬 Notes, or press C at the playhead). Treat them like PR review comments:
1. At the start of a session, and whenever the user says they left notes: `python scripts/montage.py comments <project>` (checklist: `[ ]` new/todo = your turn, `[?]` you asked or answered and the user has not replied, `[~]` fixed and waiting for approval, `[x]` resolved; colours in the editor: blue new, orange user replied again, violet Claude replied, teal fixed, green resolved).
2. Fix each open note in the edit, then answer it: `python scripts/montage.py reply <project> <id> "what you changed" --fixed`. Without `--fixed` it stays open (use that for a question or a disagreement).
3. Never resolve a note yourself. The user approves it in the editor (✓ Approve) or sends it back (Not yet / a reply), exactly like resolving a review thread.
4. Your own observations can be left as `note <project> "text" --clip ID --offset S`; the user resolves those too.
Notes live in `timeline.json` under `comments` (pinned to a clip, so they follow it when clips move).

## Rules of thumb
- Hebrew text works (RTL is automatic). Keep on-screen text short.
- Look before you cut: use `source_media_review` / contact sheets for videos; prefer the strongest 2-4 s of each video; drop near-duplicate photos.
- Rhythm: vary photo `hold` (1.5-3 s), mix `punch`/zoom/pan motions, use `flash`/`whip` on beat-heavy parts, `fade` for calm parts.
- Add a chapter card per day/place, a title-card first (after the Brand opener), an outro last. Do not stack more than one motion scene in a row.
- The user may be editing in the browser. If a command fails with a changed-file problem or you see their change in `show`, read it first and build on it; never overwrite their work.
- Preview-render and look at frames (`ffmpeg -i <mp4> -vf "select='eq(n,15)+eq(n,90)',tile=2x1" ...`) before telling the user it is done. Say plainly what was checked.
- Commit work on the branch only; **never push** (origin is the public upstream).

## Two ways to make animation
1. **HyperFrames motion scenes** (`scene` command): fast, deterministic, editable later in the UI ("Motion scene" form + Re-render). Templates live in `motion_templates/<id>/` (`index.html` + `template.json`). To add a template: copy an existing one, keep the `__W__ __H__ __DUR__` placeholders and the `data-composition-variables` list, use only transforms/opacity in GSAP (no `letterSpacing`), font Heebo only, then check with `npx hyperframes lint <scene dir>` and render a draft to look at it. Note `hyperframes snapshot` shows template defaults, not your variables.
2. **Claude Motion artifact** (free-form code animation made in Claude, exported as MP4 by the user): use when no template fits (maps, logo reveals, custom graphics). The user exports the MP4; bring it in with `import` or the editor's "＋ Import", then place it with `patch`/`move`.

## Done means
Preview rendered and inspected, the user has seen it in the editor, and the final export only after their OK.
