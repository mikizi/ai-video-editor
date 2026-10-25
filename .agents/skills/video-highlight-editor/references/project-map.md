# Project map

Use this reference after the skill triggers.

## Governance and routing

- `AGENTS.md` — mandatory entrypoint.
- `AGENT_GUIDE.md` — pipeline, preflight, decision, checkpoint, runtime, and delivery contract.
- `PROJECT_CONTEXT.md` — architecture and repository conventions.
- `pipeline_defs/hybrid.yaml` — default pipeline for multi-source highlights.
- `pipeline_defs/clip-factory.yaml` — one-long-source derivative pipeline.
- `pipeline_defs/cinematic.yaml` — mood-led trailer pipeline.
- `skills/meta/video-reference-analyst.md` — analyze inspiration videos.
- `skills/meta/source-media-review.md` — review source footage when present.
- `skills/meta/reviewer.md` — stage self-review.
- `skills/meta/checkpoint-protocol.md` — checkpoint and human-gate rules.

## Hybrid stage skills

- `skills/pipelines/hybrid/executive-producer.md`
- `skills/pipelines/hybrid/idea-director.md`
- `skills/pipelines/hybrid/script-director.md`
- `skills/pipelines/hybrid/scene-director.md`
- `skills/pipelines/hybrid/asset-director.md`
- `skills/pipelines/hybrid/edit-director.md`
- `skills/pipelines/hybrid/compose-director.md`
- `skills/pipelines/hybrid/publish-director.md`

## Layer 3 knowledge

- `.agents/skills/video-understand/SKILL.md`
- `.agents/skills/video-edit/SKILL.md`
- `.agents/skills/video-toolkit/SKILL.md`
- `.agents/skills/video-download/SKILL.md`
- `.agents/skills/remotion/SKILL.md`
- `.agents/skills/remotion-best-practices/SKILL.md`
- `.agents/skills/ffmpeg/SKILL.md`
- `.agents/skills/music/SKILL.md`
- `.agents/skills/sound-effects/SKILL.md`
- `.agents/skills/speech-to-text/SKILL.md`

Read only the Layer 3 files required by the selected tools, except the Remotion trio required by the compose section of the main skill.

## Core commands

Run from the repository root.

```bash
python -c "from tools.tool_registry import registry; import json; registry.discover(); print(json.dumps(registry.provider_menu_summary(), indent=2))"
```

```bash
python -c "from lib.checkpoint import init_project; init_project('<project-id>', title='<Title>', pipeline_type='hybrid')"
```

```bash
python -m backlot open <project-id>
```

Inspect media with the repository's registered analysis tools first. Use `ffprobe` directly only for low-level verification or debugging, not as a replacement for pipeline tools.

## Canonical outputs

- `artifacts/source_media_review.json`
- `artifacts/brief.json`
- `artifacts/decision_log.json`
- `artifacts/script.json`
- `artifacts/scene_plan.json`
- `artifacts/asset_manifest.json`
- `artifacts/edit_decisions.json`
- `artifacts/render_report.json`
- `artifacts/final_review.json`
- `artifacts/publish_log.json`
- `renders/<master-name>.mp4`
- `exports/<derivative-name>.mp4`

Validate canonical JSON against `schemas/artifacts/` before completing each checkpoint.
