---
name: video-highlight-editor
description: Turn folders of source videos, photos, screen recordings, and optional music into polished highlight films using the OpenMontage pipelines and Remotion, HyperFrames, or FFmpeg. Use when the user asks to make, continue, revise, render, or deliver a montage, recap, family film, travel edit, event highlight, social reel, source-footage story, or multi-video compilation; when they mention a folder containing many clips; or when they explicitly invoke $video-highlight-editor.
---

# Video Highlight Editor

Create source-led highlight films inside the OpenMontage project. Treat every file in the supplied folders as a candidate, select meaningful moments, build a coherent story, add music and graphics deliberately, and produce verified deliverables.

## Start correctly

1. Read `AGENTS.md` and `AGENT_GUIDE.md` at the repository root.
2. Read [references/project-map.md](references/project-map.md) for the files and commands used by this workflow.
3. Distinguish the request:
   - Use `hybrid` for several source clips plus titles, music, overlays, photos, or support material.
   - Use `clip-factory` for derivatives from one long source.
   - Use `cinematic` only when the approved promise is a mood-led trailer rather than a source-led memory or recap.
   - Use `video-reference-analyst` first when a supplied video is inspiration rather than footage to edit.
4. Read the selected pipeline manifest and every stage-director skill before executing that stage.
5. Read each selected tool's Layer 3 skill before calling the tool.

Do not bypass the pipeline, checkpoint contract, artifact schemas, or Backlot project layout.

## Review all supplied media

Build a complete inventory before choosing highlights.

- Recursively enumerate video, image, and audio files in every supplied folder.
- Record duration, dimensions, rotation, frame rate, codec, audio presence, and file size.
- Generate contact sheets or sampled frames for long or ambiguous clips.
- Transcribe speech when dialogue could affect the story.
- Detect scenes and evaluate candidate windows for action, emotion, clarity, novelty, and technical quality.
- Group near-duplicates and retain the best version while preserving alternates in the inventory.
- Treat explicitly named files as priorities, not as the only allowed sources.
- Do not omit nested folders merely because they look like old CapCut projects or exports.

Create or update `source_media_review` so later stages can trace every selected moment back to its source.

## Initialize or resume the project

- Resume an existing `projects/<project-id>/` workspace when the user names it or the current board already points to it.
- Otherwise initialize a kebab-case project with `lib.checkpoint.init_project`.
- Open the Backlot board with `python -m backlot open <project-id>`. Continue if the board cannot open.
- Ask `checkpoint.get_next_stage()` where to resume.
- Keep canonical artifacts in `projects/<project-id>/artifacts/`, media in the project asset folders, snapshots in `snapshots/`, and deliverables in `renders/` or `exports/`.
- Preserve append-only decisions and archived checkpoint history.

## Run preflight and proposal

Run `registry.provider_menu_summary()` and present the real capability envelope. Inspect the available composition runtimes.

When both Remotion and HyperFrames are available:

- Present both with a brief, project-specific strength and tradeoff.
- Recommend one, then wait for approval.

Also present the authoring-mode choice:

- `templated` for fast, repeatable drafts and variants.
- `atelier` for a one-off hero film with bespoke scenes and motion.

For a folder-led personal highlight, normally recommend the `hybrid` pipeline with source footage as the anchor, Remotion for integrated footage and React overlays, and atelier mode when the film should feel special.

When the brief is open, present four or five distinct concepts. Include:

- narrative arc and hook;
- target duration, aspect ratio, and platform;
- approximate source/support balance;
- music plan;
- runtime and authoring mode;
- cost, quality, and approval gates.

Do not begin consequential generation before the required proposal approval.

## Build the story

Prefer a clear emotional or thematic progression over chronological dumping. Typical structures include:

- cold open -> setup -> escalating moments -> payoff -> closing memory;
- many chapters -> recurring motif -> finale;
- challenge -> attempts -> breakthrough -> celebration;
- day-in-the-life -> contrasts -> reflection.

Use source audio when it carries meaning. Duck music under speech. Add captions only when they improve comprehension or rhythm. Keep graphics subordinate to the footage unless the approved concept is deliberately motion-graphics-led.

For vertical edits, reframe intentionally around faces and action; do not rely on a single center crop for every clip. Use still images with restrained motion and shorter holds than live footage.

## Handle music and external material

Follow the repository music order:

1. Check `music_library/`.
2. Check configured music-generation tools.
3. Offer a user-provided or royalty-free track.
4. Proceed without music only with the user's knowledge.

If the user authorizes downloading a YouTube asset they have permission to reuse, read `.agents/skills/video-download/SKILL.md` and use the existing downloader workflow. Record the URL, downloaded file, license or permission statement, and exact in/out range in `asset_manifest`. Use external footage only when it materially improves the story.

Never let a soundtrack obscure dialogue. Use fades, beat-aware cuts, loudness control, and final peak checks.

## Compose and verify

Before composing with Remotion, read:

- `.agents/skills/remotion/SKILL.md`
- `.agents/skills/remotion-best-practices/SKILL.md`
- `.agents/skills/ffmpeg/SKILL.md`

For atelier work, also read `skills/meta/taste-direction.md` and `skills/meta/bespoke-composition.md`.

Render storyboards at representative chapter frames before the master. Inspect them visually. Then render the master and verify:

- expected duration, dimensions, frame rate, codecs, and audio streams;
- no missing assets, broken overlays, black frames, freezes, clipping, or unintended silence;
- readable safe-area text and captions;
- coherent pacing, crops, transitions, and music levels;
- runtime and authoring mode match the approved decision log.

Create an email-size or social-size derivative only after the master passes.

## Deliver safely

Keep the master as the canonical deliverable. Name derivatives by purpose.

External delivery requires an exact destination and explicit user authorization. Verify the final recipient, subject, attachment or link, and successful send state. If a connector or browser permission blocks delivery, report the precise blocker and keep clickable local outputs available.

## Useful invocations

- `Use $video-highlight-editor on the videos in this folder and make a 60-second vertical family highlight.`
- `Use $video-highlight-editor to continue project lego-nascar-race and revise the soundtrack.`
- `Use $video-highlight-editor to review every nested clip, propose three stories, and wait for my approval.`
- `Use $video-highlight-editor to render the approved Remotion edit and create an email-sized copy.`
