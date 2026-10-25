"""Render a project's montage timeline with the reusable FamilyMontage composition.

    python scripts/render_timeline.py <project-id>                 # full render
    python scripts/render_timeline.py <project-id> --preview       # fast half-size draft
    python scripts/render_timeline.py <project-id> --draft         # (re)build timeline.json from public/media first
    python scripts/render_timeline.py <project-id> --seconds 0-8   # only part of the video

Reads   projects/<id>/artifacts/timeline.json
Media   projects/<id>/public/...   (paths in the timeline are relative to public/)
Writes  projects/<id>/renders/<name>.mp4
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lib import timeline as T  # noqa: E402

# Override when node_modules were installed for another OS (e.g. a Linux VM
# running against a macOS checkout): point this at a Linux copy of remotion-composer.
COMPOSER = Path(os.environ.get("REMOTION_COMPOSER_DIR", ROOT / "remotion-composer"))


def check_media(project: Path, tl: dict) -> list[str]:
    public = project / "public"
    srcs = [c["src"] for c in tl["clips"]]
    if tl.get("opener"):
        srcs.append(tl["opener"]["src"])
    if tl.get("music"):
        srcs.append(tl["music"]["src"])
    return [s for s in srcs if not s.startswith(("http:", "https:")) and not (public / s).exists()]


def render(project_id: str, out: Path | None = None, preview: bool = False,
           seconds: str | None = None, concurrency: int | None = None) -> Path:
    project = ROOT / "projects" / project_id
    tl = T.load(T.timeline_path(project))
    missing = check_media(project, tl)
    if missing:
        raise SystemExit("Missing media (relative to public/):\n  " + "\n  ".join(missing))

    renders = project / "renders"
    renders.mkdir(parents=True, exist_ok=True)
    if out is None:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        out = renders / f"montage-{'preview-' if preview else ''}{stamp}.mp4"
    out = Path(out).resolve()

    props_file = project / "artifacts" / ".render-props.json"
    props_file.write_text(json.dumps(T.to_remotion_props(tl), ensure_ascii=False), encoding="utf-8")

    cmd = [
        "npx", "remotion", "render", "src/montage/index.tsx", "FamilyMontage", str(out),
        f"--props={props_file}", f"--public-dir={project / 'public'}",
        "--codec=h264",
    ]
    if preview:
        cmd += ["--crf=28", "--jpeg-quality=75"]
    else:
        # Final export: high quality. Remotion's default frame capture is
        # JPEG q80, which softens phone footage; capture near-lossless instead.
        cmd += ["--crf=16", "--jpeg-quality=95", "--x264-preset=slow"]
    if preview:
        cmd.append("--scale=0.5")
    if concurrency:
        cmd.append(f"--concurrency={concurrency}")
    if seconds:
        fps = (tl.get("format") or {}).get("fps", 30)
        a, b = (float(x) for x in seconds.split("-"))
        cmd.append(f"--frames={int(a * fps)}-{int(b * fps) - 1}")

    lay = T.layout(tl)
    print(f"Rendering {len(tl['clips'])} clips, {lay['total_seconds']:.1f}s -> {out}")
    subprocess.run(cmd, cwd=COMPOSER, check=True)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project_id")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--preview", action="store_true", help="half size, lower quality, faster")
    ap.add_argument("--seconds", help="render only a range, e.g. 0-8")
    ap.add_argument("--concurrency", type=int)
    ap.add_argument("--draft", action="store_true", help="build timeline.json from public/media first (overwrites!)")
    ap.add_argument("--aspect", default="9:16", choices=sorted(T.FORMATS))
    args = ap.parse_args()

    if args.draft:
        project = ROOT / "projects" / args.project_id
        tl = T.draft_from_media(project, aspect=args.aspect)
        path = T.save(T.timeline_path(project), tl)
        print(f"Draft timeline written: {path} ({len(tl['clips'])} clips, {T.total_seconds(tl):.1f}s)")

    render(args.project_id, args.out, args.preview, args.seconds, args.concurrency)


if __name__ == "__main__":
    main()
