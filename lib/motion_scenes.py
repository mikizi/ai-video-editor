"""Motion scenes: animated HyperFrames clips that sit on the montage timeline.

A *template* lives in ``motion_templates/<id>/`` (``index.html`` + ``template.json``).
A *scene* is a template filled with text/colors/photos, kept as a workspace in
``projects/<project>/motion/<scene-id>/`` and rendered to
``projects/<project>/public/motion/<scene-id>.mp4``.  The result is a normal
video clip for ``timeline.json`` with a ``generated`` field, so the editor can
re-open the scene, change its text and render it again.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Optional

from lib import timeline as T
from lib.paths import PROJECTS_DIR, REPO_ROOT

TEMPLATES_DIR = REPO_ROOT / "motion_templates"
SHARED_DIR = TEMPLATES_DIR / "_shared"
SHARED_FILES = ("base.css", "gsap.min.js", "motion-kit.js")
FPS = 30
_SCENE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")


class MotionSceneError(ValueError):
    pass


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------

def list_templates() -> list[dict[str, Any]]:
    out = []
    for d in sorted(TEMPLATES_DIR.iterdir()):
        meta = d / "template.json"
        if d.is_dir() and not d.name.startswith("_") and meta.exists() and (d / "index.html").exists():
            out.append(json.loads(meta.read_text(encoding="utf-8")))
    return out


def get_template(template_id: str) -> dict[str, Any]:
    for t in list_templates():
        if t["id"] == template_id:
            return t
    raise MotionSceneError(f"unknown motion template: {template_id}")


def _defaults(template: dict[str, Any]) -> dict[str, Any]:
    return {f["id"]: f.get("default", "") for f in template["fields"]}


# ---------------------------------------------------------------------------
# Scene workspace
# ---------------------------------------------------------------------------

def scene_dir(project_id: str, scene_id: str) -> Path:
    if not _SCENE_ID.match(scene_id):
        raise MotionSceneError(f"bad scene id: {scene_id!r} (use a-z, 0-9, dashes)")
    return PROJECTS_DIR / project_id / "motion" / scene_id


def output_rel(scene_id: str) -> str:
    """Path of the rendered MP4, relative to the project's public/ folder."""
    return f"motion/{scene_id}.mp4"


def new_scene_id(project_id: str, template_id: str) -> str:
    base = PROJECTS_DIR / project_id / "motion"
    n = 1
    while (base / f"{template_id}-{n}").exists():
        n += 1
    return f"{template_id}-{n}"


def _video_fields(template: dict[str, Any]) -> list[str]:
    return [f["id"] for f in template["fields"] if f.get("type") == "video"]


def _photo_names(template: dict[str, Any], params: dict[str, Any]) -> list[str]:
    return [f["id"] for f in template["fields"] if f.get("type") == "photo" and params.get(f["id"])]


def create_scene(
    project_id: str,
    template_id: str,
    scene_id: Optional[str] = None,
    params: Optional[dict[str, Any]] = None,
    seconds: Optional[float] = None,
    fmt: Optional[dict[str, int]] = None,
) -> dict[str, Any]:
    """Make (or refresh) a scene workspace. Returns the scene description.

    ``params`` may contain text/color values.  For ``photo`` fields pass a path
    relative to the project's ``public/`` folder; the file is copied into the
    workspace's ``assets/`` and the variable becomes just the file name.
    """
    template = get_template(template_id)
    project = PROJECTS_DIR / project_id
    if not project.is_dir():
        raise MotionSceneError(f"unknown project: {project_id}")
    scene_id = scene_id or new_scene_id(project_id, template_id)
    work = scene_dir(project_id, scene_id)
    work.mkdir(parents=True, exist_ok=True)

    fmt = fmt or template.get("format") or _project_format(project)  # a template may fix its own size (e.g. a tall strip)
    width, height = int(fmt["width"]), int(fmt["height"])
    secs = float(seconds or template.get("default_seconds", 3.5))
    if secs <= 0:
        raise MotionSceneError("seconds must be greater than 0")
    # Whole frames only, so the rendered file length matches the timeline exactly.
    secs = round(secs * FPS) / FPS

    values = {**_defaults(template), **(params or {})}
    assets = work / "assets"
    for fid in _photo_names(template, values):
        rel = str(values[fid])
        src = (project / "public" / rel).resolve()
        if not src.is_file() or (project / "public").resolve() not in src.parents:
            # Re-editing a scene: the value may already be a file name inside assets/.
            if (assets / Path(rel).name).is_file():
                values[fid] = Path(rel).name
                continue
            raise MotionSceneError(f"photo not found in public/: {rel}")
        assets.mkdir(exist_ok=True)
        shutil.copy2(src, assets / src.name)
        values[fid] = src.name

    # Video fields (a moving backdrop or a moving photo): copied to assets/<field id>.mp4; an empty field gets a tiny black clip
    # so the template's <video> element always has a file to point at.
    for fid in _video_fields(template):
        assets.mkdir(exist_ok=True)
        rel = str(values.get(fid) or "")
        target, real = assets / f"{fid}.mp4", False
        if rel:
            src = (project / "public" / rel).resolve()
            if src.is_file() and (project / "public").resolve() in src.parents:
                shutil.copy2(src, target); real = True
            elif rel == f"{fid}.mp4" and target.is_file():     # re-editing a scene: already in assets/
                real = True
            else:
                raise MotionSceneError(f"video not found in public/: {rel}")
        if not real:
            shutil.copy2(SHARED_DIR / "blank.mp4", target)
        values[fid] = f"{fid}.mp4" if real else ""

    html = (TEMPLATES_DIR / template_id / "index.html").read_text(encoding="utf-8")
    html = html.replace("__W__", str(width)).replace("__H__", str(height)).replace("__DUR__", f"{secs:g}")
    (work / "index.html").write_text(html, encoding="utf-8")
    for name in SHARED_FILES:
        shutil.copy2(SHARED_DIR / name, work / name)
    (work / "vars.json").write_text(json.dumps(values, ensure_ascii=False, indent=2), encoding="utf-8")

    generated = {"engine": "hyperframes", "scene": scene_id, "template": template_id, "params": values}
    (work / "scene.json").write_text(
        json.dumps({**generated, "seconds": secs, "width": width, "height": height}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {"scene": scene_id, "dir": work, "seconds": secs, "generated": generated}


def _project_format(project: Path) -> dict[str, int]:
    path = T.timeline_path(project)
    if path.exists():
        try:
            f = json.loads(path.read_text(encoding="utf-8")).get("format") or {}
            return {"width": f.get("width", 1080), "height": f.get("height", 1920)}
        except ValueError:
            pass
    return {"width": 1080, "height": 1920}


# ---------------------------------------------------------------------------
# Check + render
# ---------------------------------------------------------------------------

def _npx(args: list[str], cwd: Path, timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(["npx", "--yes", "hyperframes", *args], cwd=cwd, capture_output=True, text=True, timeout=timeout)


def check_scene(project_id: str, scene_id: str) -> dict[str, Any]:
    """Run ``hyperframes lint``. Returns {ok, output}."""
    work = scene_dir(project_id, scene_id)
    res = _npx(["lint", str(work)], REPO_ROOT, 180)
    out = (res.stdout + res.stderr).strip()
    # Warnings (⚠) are fine; only real errors (✗) block a render.
    return {"ok": res.returncode == 0 or "✗" not in out, "output": out}


def snapshot_scene(project_id: str, scene_id: str, frames: int = 5) -> dict[str, Any]:
    """Save a few PNG frames to ``motion/<scene>/snapshots/`` for a visual check."""
    work = scene_dir(project_id, scene_id)
    res = _npx(["snapshot", str(work), "--frames", str(frames)], REPO_ROOT, 300)
    return {"ok": res.returncode == 0, "output": (res.stdout + res.stderr).strip()}


def render_scene(project_id: str, scene_id: str, quality: str = "high") -> dict[str, Any]:
    """Render the workspace to ``public/motion/<scene>.mp4`` and return a timeline clip."""
    work = scene_dir(project_id, scene_id)
    meta_path = work / "scene.json"
    if not meta_path.exists():
        raise MotionSceneError(f"no scene workspace: {scene_id}")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    out = PROJECTS_DIR / project_id / "public" / output_rel(scene_id)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".rendering.mp4")
    res = _npx(
        ["render", str(work), "--output", str(tmp), "--quality", quality, "--variables-file", str(work / "vars.json")],
        REPO_ROOT, 900,
    )
    if res.returncode != 0 or not tmp.exists():
        tmp.unlink(missing_ok=True)
        raise MotionSceneError(f"render failed:\n{(res.stdout + res.stderr)[-1500:]}")
    tmp.replace(out)  # only swap in the new file once it is complete
    dur = T.probe_duration(out) or meta["seconds"]
    return {"clip": scene_clip(scene_id, meta, dur), "path": out}


def scene_clip(scene_id: str, meta: dict[str, Any], duration: float) -> dict[str, Any]:
    """A timeline clip (kind video) for a rendered scene."""
    return {
        "id": scene_id,
        "src": output_rel(scene_id),
        "kind": "video",
        "label": meta["template"],
        "in": 0,
        "out": round(duration, 3),
        "source_duration": round(duration, 3),
        "speed": 1,
        "volume": 0,
        "fit": "cover",
        "motion": "none",
        "transition": {"type": "fade", "seconds": 0.3},
        "generated": {k: meta[k] for k in ("engine", "scene", "template", "params")},
    }


def read_scene(project_id: str, scene_id: str) -> dict[str, Any]:
    meta_path = scene_dir(project_id, scene_id) / "scene.json"
    if not meta_path.exists():
        raise MotionSceneError(f"no scene workspace: {scene_id}")
    return json.loads(meta_path.read_text(encoding="utf-8"))
