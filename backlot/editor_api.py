"""Timeline editor API — the one part of Backlot that WRITES to a project.

It only ever writes ``projects/<id>/artifacts/timeline.json`` (validated,
atomic) and starts renders through ``scripts/render_timeline.py``. Everything
else in Backlot stays read-only.

Claude and the browser editor share the same timeline file. Every save carries
the file's mtime the client last saw; if the file changed on disk since then
(e.g. Claude edited it), the save is refused with 409 and the current file, so
nobody silently overwrites the other.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Optional

import jsonschema
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from lib import beats as B
from lib import motion_scenes as M
from lib import timeline as T
from lib.paths import PROJECTS_DIR, REPO_ROOT

router = APIRouter(prefix="/api/editor")

MEDIA_EXTS = T.VIDEO_EXTS | T.IMAGE_EXTS | T.AUDIO_EXTS
_duration_cache: dict[tuple[str, int], Optional[float]] = {}
_renders: dict[str, dict[str, Any]] = {}
_render_lock = threading.Lock()
_scene_jobs: dict[str, dict[str, Any]] = {}


def _project_dir(project_id: str) -> Path:
    if any(c in project_id for c in "/\\:") or project_id in (".", ".."):
        raise HTTPException(status_code=400, detail="invalid project id")
    d = PROJECTS_DIR / project_id
    if not d.is_dir():
        raise HTTPException(status_code=404, detail=f"unknown project: {project_id}")
    return d


def _mtime(p: Path) -> Optional[str]:
    # A string: nanosecond mtimes don't fit in a JavaScript number.
    try:
        return str(p.stat().st_mtime_ns)
    except FileNotFoundError:
        return None


def _duration(p: Path) -> Optional[float]:
    key = (str(p), p.stat().st_mtime_ns)
    if key not in _duration_cache:
        _duration_cache[key] = T.probe_duration(p)
    return _duration_cache[key]


def _kind(p: Path) -> Optional[str]:
    s = p.suffix.lower()
    if s in T.VIDEO_EXTS:
        return "video"
    if s in T.IMAGE_EXTS:
        return "image"
    if s in T.AUDIO_EXTS:
        return "audio"
    return None


# ---------------------------------------------------------------------------
# Timeline
# ---------------------------------------------------------------------------

@router.get("/{project_id}/timeline")
async def get_timeline(project_id: str) -> dict:
    d = _project_dir(project_id)
    path = T.timeline_path(d)
    if not path.exists():
        return {"timeline": None, "mtime": None}
    try:
        tl = await asyncio.to_thread(T.load, path)
    except (jsonschema.ValidationError, T.TimelineError, ValueError) as exc:
        return {"timeline": None, "mtime": _mtime(path), "error": str(getattr(exc, "message", exc))}
    return {"timeline": tl, "mtime": _mtime(path)}


class SaveBody(BaseModel):
    timeline: dict
    base_mtime: Optional[str] = None
    force: bool = False


@router.put("/{project_id}/timeline")
async def put_timeline(project_id: str, body: SaveBody) -> dict:
    d = _project_dir(project_id)
    path = T.timeline_path(d)
    current = _mtime(path)
    if not body.force and current is not None and body.base_mtime != current:
        tl = await asyncio.to_thread(T.load, path)
        raise HTTPException(status_code=409, detail={"message": "timeline changed on disk", "timeline": tl, "mtime": current})
    try:
        await asyncio.to_thread(lambda: T.save(path, body.timeline, merge_comments=False))
    except jsonschema.ValidationError as exc:
        raise HTTPException(status_code=422, detail=f"{'/'.join(map(str, exc.absolute_path))}: {exc.message}")
    except T.TimelineError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"ok": True, "mtime": _mtime(path)}


class DraftBody(BaseModel):
    aspect: str = "9:16"
    overwrite: bool = False


@router.post("/{project_id}/draft")
async def make_draft(project_id: str, body: DraftBody) -> dict:
    d = _project_dir(project_id)
    path = T.timeline_path(d)
    if path.exists() and not body.overwrite:
        raise HTTPException(status_code=409, detail="timeline already exists")
    if body.aspect not in T.FORMATS:
        raise HTTPException(status_code=422, detail=f"unknown aspect {body.aspect}")
    try:
        tl = await asyncio.to_thread(T.draft_from_media, d, "media", body.aspect)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    await asyncio.to_thread(T.save, path, tl)
    return {"timeline": tl, "mtime": _mtime(path)}


# ---------------------------------------------------------------------------
# Media bin
# ---------------------------------------------------------------------------

@router.get("/{project_id}/media")
async def list_media(project_id: str) -> dict:
    d = _project_dir(project_id)
    public = d / "public"

    def scan() -> list[dict]:
        out = []
        if not public.is_dir():
            return out
        for p in sorted(public.rglob("*")):
            if not p.is_file() or p.name.startswith("."):
                continue
            rel_parts = p.relative_to(public).parts
            # HyperFrames keeps temporary work folders / half-written files next to the output.
            if p.name.endswith(".rendering.mp4") or any(x.startswith("work-") for x in rel_parts[:-1]):
                continue
            kind = _kind(p)
            if not kind:
                continue
            rel = p.relative_to(public).as_posix()
            item = {"src": rel, "name": p.name, "folder": rel.rsplit("/", 1)[0] if "/" in rel else "",
                    "kind": kind, "bytes": p.stat().st_size}
            if kind in ("video", "audio"):
                item["duration"] = _duration(p)
            out.append(item)
        return out

    return {"media": await asyncio.to_thread(scan)}


# ---------------------------------------------------------------------------
# Render (runs scripts/render_timeline.py in the background)
# ---------------------------------------------------------------------------

class RenderBody(BaseModel):
    preview: bool = True


_PROGRESS = re.compile(r"(\d+)\s*/\s*(\d+)")


def _run_render(project_id: str, preview: bool, out: Path) -> None:
    job = _renders[project_id]
    cmd = [sys.executable, str(REPO_ROOT / "scripts" / "render_timeline.py"), project_id, "--out", str(out)]
    if preview:
        cmd.append("--preview")
    try:
        proc = subprocess.Popen(cmd, cwd=REPO_ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, bufsize=1)
        job["pid"] = proc.pid
        assert proc.stdout is not None
        buf = ""
        while True:
            ch = proc.stdout.read(256)
            if not ch:
                break
            buf = (buf + ch)[-4000:]
            job["log"] = buf
            # Remotion prints e.g. "Rendered 120/840" — keep the last pair.
            for line in reversed(re.split(r"[\r\n]", buf)):
                if "Render" in line or "Encod" in line:
                    m = _PROGRESS.search(line)
                    if m and int(m.group(2)) > 0:
                        job["progress"] = min(1.0, int(m.group(1)) / int(m.group(2)))
                        job["stage"] = "encoding" if "Encod" in line else "rendering"
                        break
        rc = proc.wait()
        job["ok"] = rc == 0
        job["error"] = None if rc == 0 else f"render failed (exit {rc})"
    except Exception as exc:  # pragma: no cover - surfaced to the UI
        job["ok"] = False
        job["error"] = str(exc)
    finally:
        job["running"] = False
        job["finished_at"] = time.time()


@router.post("/{project_id}/render")
async def start_render(project_id: str, body: RenderBody) -> dict:
    d = _project_dir(project_id)
    if not T.timeline_path(d).exists():
        raise HTTPException(status_code=404, detail="no timeline yet")
    with _render_lock:
        job = _renders.get(project_id)
        if job and job.get("running"):
            raise HTTPException(status_code=409, detail="a render is already running")
        stamp = time.strftime("%Y%m%d-%H%M%S")
        out = d / "renders" / f"montage-{'preview' if body.preview else 'final'}-{stamp}.mp4"
        _renders[project_id] = {
            "running": True, "preview": body.preview, "progress": 0.0, "stage": "starting",
            "log": "", "ok": None, "error": None, "started_at": time.time(),
            "output": out.relative_to(d).as_posix(),
        }
    threading.Thread(target=_run_render, args=(project_id, body.preview, out), daemon=True).start()
    return _renders[project_id]


@router.get("/{project_id}/render")
async def render_status(project_id: str) -> dict:
    _project_dir(project_id)
    return _renders.get(project_id) or {"running": False}


# ---------------------------------------------------------------------------
# Motion scenes (HyperFrames templates -> a video clip)
# ---------------------------------------------------------------------------

@router.get("/{project_id}/motion/templates")
async def motion_templates(project_id: str) -> dict:
    _project_dir(project_id)
    return {"templates": M.list_templates()}


class SceneBody(BaseModel):
    template: str
    scene: Optional[str] = None          # given when re-editing an existing scene
    params: dict = {}
    seconds: Optional[float] = None


def _build_scene(project_id: str, body: SceneBody) -> dict:
    sc = M.create_scene(project_id, body.template, body.scene, body.params, body.seconds)
    lint = M.check_scene(project_id, sc["scene"])
    if not lint["ok"]:
        raise M.MotionSceneError("scene check failed:\n" + lint["output"][-1200:])
    return M.render_scene(project_id, sc["scene"])["clip"]


@router.post("/{project_id}/motion/render")
async def motion_render(project_id: str, body: SceneBody) -> dict:
    """Create (or update) a scene, check it, render it. Returns the timeline clip."""
    _project_dir(project_id)
    with _render_lock:
        job = _scene_jobs.get(project_id)
        if job and job.get("running"):
            raise HTTPException(status_code=409, detail="a scene is already rendering")
        _scene_jobs[project_id] = {"running": True, "ok": None, "error": None, "clip": None, "started_at": time.time()}

    def work() -> None:
        job = _scene_jobs[project_id]
        try:
            job["clip"] = _build_scene(project_id, body)
            job["ok"] = True
        except (M.MotionSceneError, subprocess.TimeoutExpired, OSError) as exc:
            job["ok"], job["error"] = False, str(exc)
        finally:
            job["running"] = False

    threading.Thread(target=work, daemon=True).start()
    return _scene_jobs[project_id]


@router.get("/{project_id}/motion/render")
async def motion_render_status(project_id: str) -> dict:
    _project_dir(project_id)
    return _scene_jobs.get(project_id) or {"running": False}


# ---------------------------------------------------------------------------
# New project + importing media into public/media
# ---------------------------------------------------------------------------

class NewProjectBody(BaseModel):
    title: str


@router.post("/projects")
async def new_project(body: NewProjectBody) -> dict:
    """Create an empty project workspace so a montage can be started from the Library."""
    from lib.checkpoint import init_project

    title = body.title.strip()
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:48]
    if not slug:
        raise HTTPException(status_code=422, detail="give the project a name (letters or numbers)")
    if (PROJECTS_DIR / slug).exists():
        raise HTTPException(status_code=409, detail=f"a project named {slug} already exists")
    await asyncio.to_thread(init_project, slug, title=title, pipeline_type="hybrid")
    (PROJECTS_DIR / slug / "public" / "media").mkdir(parents=True, exist_ok=True)
    return {"project_id": slug}


def _scan_media(folder: Path) -> list[Path]:
    exts = T.VIDEO_EXTS | T.IMAGE_EXTS
    return sorted(
        (p for p in folder.rglob("*")
         if p.is_file() and p.suffix.lower() in exts
         and not any(x.startswith(".") or x.endswith("_frames") or x in ("source-review", "stills")
                     for x in p.relative_to(folder).parts[:-1])),
        key=lambda p: p.relative_to(folder).as_posix().lower(),
    )


def _import_files(files: list[Path], dest: Path) -> int:
    """Hard-link (or copy) photos/videos into dest, never overwriting; same name -> name-2.ext."""
    dest.mkdir(parents=True, exist_ok=True)
    n = 0
    for src in files:
        target = dest / src.name
        k = 2
        while target.exists():
            if target.stat().st_size == src.stat().st_size:
                target = None  # already imported
                break
            target = dest / f"{src.stem}-{k}{src.suffix}"
            k += 1
        if target is None:
            continue
        try:
            os.link(src, target)
        except OSError:
            shutil.copy2(src, target)
        n += 1
    return n


@router.get("/{project_id}/sources")
async def list_sources(project_id: str) -> dict:
    """What can be imported: the project's own source-media folders + what is already in the bin."""
    d = _project_dir(project_id)

    def scan() -> dict:
        folders = []
        src = d / "source-media"
        if src.is_dir():
            def junk(path: Path) -> bool:  # frames/stills the review tools extract are not footage
                return any(x.startswith(".") or x.endswith("_frames") or x in ("source-review", "stills")
                           for x in path.relative_to(src).parts)

            for sub in [src, *sorted(p for p in src.rglob("*") if p.is_dir() and not junk(p))]:
                direct = [p for p in sub.iterdir() if p.is_file() and p.suffix.lower() in T.VIDEO_EXTS | T.IMAGE_EXTS]
                if direct:
                    folders.append({"path": sub.relative_to(d).as_posix(), "count": len(direct)})
        media = d / "public" / "media"
        return {"folders": folders, "in_bin": len(_scan_media(media)) if media.is_dir() else 0}

    return await asyncio.to_thread(scan)


class ImportBody(BaseModel):
    folder: str  # inside the project (e.g. "source-media/google-photos/picker-x") or an absolute path on this Mac


@router.post("/{project_id}/import")
async def import_media(project_id: str, body: ImportBody) -> dict:
    d = _project_dir(project_id)
    raw = body.folder.strip()
    folder = Path(os.path.expanduser(raw))
    if not folder.is_absolute():
        folder = (d / raw).resolve()
        if d.resolve() not in folder.parents and folder != d.resolve():
            raise HTTPException(status_code=400, detail="folder must be inside the project")
    if not folder.is_dir():
        raise HTTPException(status_code=404, detail=f"folder not found: {folder}")
    files = await asyncio.to_thread(_scan_media, folder)
    if not files:
        raise HTTPException(status_code=422, detail="no photos or videos in that folder")
    added = await asyncio.to_thread(_import_files, files, d / "public" / "media")
    return {"found": len(files), "added": added}


_gp_jobs: dict[str, dict[str, Any]] = {}


@router.post("/{project_id}/google-photos")
async def google_photos_start(project_id: str) -> dict:
    """Run the Google Photos picker (opens a browser tab on this Mac), then import what was picked."""
    d = _project_dir(project_id)
    with _render_lock:
        job = _gp_jobs.get(project_id)
        if job and job.get("running"):
            raise HTTPException(status_code=409, detail="the Google Photos picker is already open")
        _gp_jobs[project_id] = {"running": True, "ok": None, "error": None, "added": 0, "log": ""}

    def work() -> None:
        job = _gp_jobs[project_id]
        try:
            before = set((d / "source-media" / "google-photos").glob("picker-*")) if (d / "source-media" / "google-photos").is_dir() else set()
            proc = subprocess.run(
                [sys.executable, str(REPO_ROOT / "scripts" / "import_google_photos.py"), "--project", project_id],
                cwd=REPO_ROOT, capture_output=True, text=True, timeout=1800,
            )
            job["log"] = (proc.stdout + proc.stderr)[-1500:]
            if proc.returncode != 0:
                raise RuntimeError("the picker did not finish (see log)")
            gp = d / "source-media" / "google-photos"
            new = [p for p in gp.glob("picker-*") if p not in before] if gp.is_dir() else []
            if not new:
                raise RuntimeError("nothing was picked")
            files = [f for p in new for f in _scan_media(p)]
            job["added"] = _import_files(files, d / "public" / "media")
            job["ok"] = True
        except Exception as exc:  # surfaced in the UI
            job["ok"], job["error"] = False, str(exc)
        finally:
            job["running"] = False

    threading.Thread(target=work, daemon=True).start()
    return _gp_jobs[project_id]


@router.get("/{project_id}/google-photos")
async def google_photos_status(project_id: str) -> dict:
    _project_dir(project_id)
    return _gp_jobs.get(project_id) or {"running": False}


# ---------------------------------------------------------------------------
# Beats from the song
# ---------------------------------------------------------------------------

def _music_src(project_id: str) -> str:
    path = T.timeline_path(_project_dir(project_id))
    if not path.exists():
        raise HTTPException(status_code=404, detail="no timeline yet")
    music = T.load(path).get("music")
    if not music:
        raise HTTPException(status_code=422, detail="add a song to the timeline first")
    return music["src"]


@router.get("/{project_id}/beats")
async def get_beats(project_id: str) -> dict:
    """Saved beats for the timeline's song (no detection run), or {beats: null}."""
    src = _music_src(project_id)
    return {"beats": await asyncio.to_thread(B.cached_beats, _project_dir(project_id), src)}


class DetectBody(BaseModel):
    src: Optional[str] = None   # song to analyse (defaults to the timeline's song)
    force: bool = False


@router.post("/{project_id}/beats")
async def detect_beats(project_id: str, body: DetectBody) -> dict:
    d = _project_dir(project_id)
    src = body.src or _music_src(project_id)
    try:
        return {"beats": await asyncio.to_thread(B.detect_song_beats, d, src, body.force)}
    except B.BeatError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="beat detection took too long")


class SnapBody(BaseModel):
    timeline: dict
    tolerance: float = 0.4


@router.post("/{project_id}/snap-beats")
async def snap_beats(project_id: str, body: SnapBody) -> dict:
    """Move clip ends onto the nearest beat (within tolerance). Returns the new timeline; nothing is saved."""
    _project_dir(project_id)
    try:
        T.validate(body.timeline)
    except (jsonschema.ValidationError, T.TimelineError) as exc:
        raise HTTPException(status_code=422, detail=str(getattr(exc, "message", exc)))
    new = T.snap_to_beats(body.timeline, tolerance=max(0.05, min(body.tolerance, 1.0)))
    return {"timeline": new}
