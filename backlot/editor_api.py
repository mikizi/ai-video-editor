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
import hashlib
import json
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
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backlot import editor_ai, editor_inspo
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


_size_cache: dict[tuple[str, int], Optional[tuple[int, int]]] = {}


_audio_cache: dict[tuple[str, int], bool] = {}


def _has_audio(p: Path) -> bool:
    key = (str(p), p.stat().st_mtime_ns)
    if key not in _audio_cache:
        _audio_cache[key] = T.probe_has_audio(p)
    return _audio_cache[key]


def _size(p: Path) -> Optional[tuple[int, int]]:
    key = (str(p), p.stat().st_mtime_ns)
    if key not in _size_cache:
        _size_cache[key] = T.probe_size(p)
    return _size_cache[key]


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
    empty: bool = False   # start with a blank timeline, no video needed


@router.post("/{project_id}/draft")
async def make_draft(project_id: str, body: DraftBody) -> dict:
    d = _project_dir(project_id)
    path = T.timeline_path(d)
    if path.exists() and not body.overwrite:
        raise HTTPException(status_code=409, detail="timeline already exists")
    if body.aspect not in T.FORMATS:
        raise HTTPException(status_code=422, detail=f"unknown aspect {body.aspect}")
    if body.empty:
        title = json.loads((d / "project.json").read_text("utf-8")).get("title") if (d / "project.json").is_file() else None
        tl = {"version": "1.0", "title": title or d.name, "format": {**T.FORMATS[body.aspect], "fps": 30},
              "style": {"font": "Heebo", "accent": "#FFD400", "grade": "warm", "vignette": False, "beat_pulse": 0.0, "background": "#000000"},
              "opener": None, "clips": [], "texts": [], "music": None, "beats": []}
        await asyncio.to_thread(T.save, path, tl)
        return {"timeline": tl, "mtime": _mtime(path)}
    try:
        tl = await asyncio.to_thread(T.draft_from_media, d, "media", body.aspect)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    await asyncio.to_thread(T.save, path, tl)
    return {"timeline": tl, "mtime": _mtime(path)}


editor_ai.register(router, _project_dir)   # saved versions + AI chat
editor_inspo.register(router, _project_dir)   # inspiration board


# ---------------------------------------------------------------------------
# Media bin
# ---------------------------------------------------------------------------

class FavBody(BaseModel):
    src: str
    on: bool = True


def _fav_path(d: Path) -> Path:
    return d / "favorites.json"


@router.get("/{project_id}/favorites")
async def get_favorites(project_id: str) -> dict:
    d = _project_dir(project_id)
    try:
        return {"favorites": json.loads(_fav_path(d).read_text("utf-8"))}
    except (OSError, ValueError):
        return {"favorites": []}


@router.post("/{project_id}/favorites")
async def set_favorite(project_id: str, body: FavBody) -> dict:
    """Heart a file in the media bin (saved per project, no change to the files themselves)."""
    d = _project_dir(project_id)
    try:
        favs = json.loads(_fav_path(d).read_text("utf-8"))
    except (OSError, ValueError):
        favs = []
    favs = [f for f in favs if f != body.src] + ([body.src] if body.on else [])
    _fav_path(d).write_text(json.dumps(favs, indent=2, ensure_ascii=False), "utf-8")
    return {"favorites": favs}


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
            st = p.stat()
            item = {"src": rel, "name": p.name, "folder": rel.rsplit("/", 1)[0] if "/" in rel else "",
                    "kind": kind, "bytes": st.st_size, "created": getattr(st, "st_birthtime", st.st_mtime)}
            if kind in ("video", "audio"):
                item["duration"] = _duration(p)
            if kind == "video":
                item["has_audio"] = _has_audio(p)
            if kind in ("video", "image"):
                size = _size(p)
                if size:
                    item["width"], item["height"] = size
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
    await asyncio.to_thread(_link_sound_library, PROJECTS_DIR / slug)
    return {"project_id": slug}


_quick: dict[str, dict[str, Any]] = {}


class QuickBody(BaseModel):
    clips: list[str] = []   # only these clips (empty = the whole timeline)


@router.post("/{project_id}/quick-export")
async def quick_export_start(project_id: str, body: Optional[QuickBody] = None) -> dict:
    """Build an MP4 of the saved timeline with ffmpeg (no Remotion), ready to download."""
    from backlot import quick_export
    d = _project_dir(project_id)
    path = T.timeline_path(d)
    if not path.exists():
        raise HTTPException(status_code=404, detail="no timeline yet")
    with _render_lock:
        job = _quick.get(project_id)
        if job and job.get("running"):
            raise HTTPException(status_code=409, detail="a download is already being prepared")
        out = d / "renders" / f"download-{time.strftime('%Y%m%d-%H%M%S')}.mp4"
        out.parent.mkdir(exist_ok=True)
        _quick[project_id] = job = {"running": True, "ok": None, "error": None, "progress": 0.0, "file": out.name}
    tl = await asyncio.to_thread(T.load, path)
    if body and body.clips:
        keep = set(body.clips)
        tl["clips"] = [c for c in tl["clips"] if c["id"] in keep]
        if not tl["clips"]:
            raise HTTPException(status_code=422, detail="the selected clip was not found")
        tl["texts"] = [x for x in tl.get("texts") or [] if x.get("follow") in keep]
        tl["layers"], tl["music"], tl["music_more"], tl["opener"] = [], None, [], None
        job["part"] = True

    def prog(v: float, _stage: str) -> None:
        job["progress"] = v

    def work() -> None:
        try:
            job.update(quick_export.export(d, tl, out, prog))
            job["ok"] = True
        except Exception as exc:
            job["ok"], job["error"] = False, str(exc)
            out.unlink(missing_ok=True)
        finally:
            job["running"] = False

    threading.Thread(target=work, daemon=True).start()
    return job


@router.get("/{project_id}/quick-export")
async def quick_export_status(project_id: str) -> dict:
    _project_dir(project_id)
    return _quick.get(project_id) or {"running": False}


@router.get("/{project_id}/quick-export/file")
async def quick_export_file(project_id: str) -> FileResponse:
    d = _project_dir(project_id)
    job = _quick.get(project_id)
    f = d / "renders" / (job or {}).get("file", "")
    if not job or not job.get("ok") or not f.is_file():
        raise HTTPException(status_code=404, detail="nothing ready to download")
    tl = json.loads(T.timeline_path(d).read_text("utf-8"))
    name = re.sub(r"[^\w\- ]+", "", tl.get("title") or project_id).strip() or project_id
    return FileResponse(f, media_type="video/mp4", filename=f"{name}.mp4")


_bgfx: dict[str, dict[str, Any]] = {}


class BgFxBody(BaseModel):
    clip: str
    mode: str                      # blur | color | image | none
    amount: Optional[float] = None  # blur strength 0-100
    color: Optional[str] = None
    image: Optional[str] = None     # path inside public/ (photo or video from the media bin)
    dry: bool = False               # preview only: make the video, return the clip changes, do not touch timeline.json
    clip_json: Optional[dict] = None  # the clip as the editor has it now (used with dry)


@router.post("/{project_id}/bgfx")
async def bgfx_start(project_id: str, body: BgFxBody) -> dict:
    """Blur or replace the background behind the person in one clip (runs on this Mac)."""
    from backlot import bg_fx
    d = _project_dir(project_id)
    path = T.timeline_path(d)
    tl = await asyncio.to_thread(T.load, path)
    clip = body.clip_json if (body.dry and body.clip_json) else next((c for c in tl["clips"] if c["id"] == body.clip), None)
    if not clip or clip.get("kind") == "image":
        raise HTTPException(status_code=422, detail="pick a video clip")
    with _render_lock:
        job = _bgfx.get(project_id)
        if job and job.get("running"):
            raise HTTPException(status_code=409, detail="a background effect is already being made")
        _bgfx[project_id] = job = {"running": True, "ok": None, "error": None, "progress": 0.0, "clip": body.clip}
    fx = body.model_dump()

    def work() -> None:
        try:
            patch = bg_fx.apply(d, project_id, clip, fx, lambda v: job.__setitem__("progress", v))
            if body.dry:
                job["patch"], job["ok"] = patch, True
                return
            cur = T.load(path)          # the user may have kept editing: patch the latest file
            tgt = next((c for c in cur["clips"] if c["id"] == body.clip), None)
            if tgt is None:
                raise RuntimeError("the clip was removed meanwhile")
            for k, v in patch.items():
                if v is None:
                    tgt.pop(k, None)
                else:
                    tgt[k] = v
            T.save(path, cur, merge_comments=True)
            job["ok"] = True
        except Exception as exc:
            job["ok"], job["error"] = False, str(exc)
        finally:
            job["running"] = False

    threading.Thread(target=work, daemon=True).start()
    return job


@router.get("/{project_id}/bgfx")
async def bgfx_status(project_id: str) -> dict:
    _project_dir(project_id)
    return _bgfx.get(project_id) or {"running": False}


@router.post("/{project_id}/upload")
async def upload_media(project_id: str, request: Request, name: str = "upload", folder: str = "uploads") -> dict:
    """Save a file the user attached or dropped (raw bytes in the body) into public/media/<folder>."""
    d = _project_dir(project_id)
    clean = re.sub(r"[^\w.\- ]+", "_", Path(name).name).strip(" .") or "upload"
    ext = Path(clean).suffix.lower()
    if ext not in (T.VIDEO_EXTS | T.IMAGE_EXTS | T.AUDIO_EXTS):
        raise HTTPException(status_code=422, detail="that file type is not a photo, video or sound")
    parts = [x for x in folder.replace("\\", "/").split("/") if x and x not in (".", "..")]
    dest = d / "public" / "media" / Path(*parts) if parts else d / "public" / "media"
    dest.mkdir(parents=True, exist_ok=True)
    target, n = dest / clean, 1
    while target.exists():
        n += 1
        target = dest / f"{Path(clean).stem} ({n}){ext}"
    size, limit = 0, 4_000_000_000
    tmp = target.with_name(f".{target.name}.part")
    try:
        with tmp.open("wb") as f:               # streamed to disk: big videos never sit in memory
            async for chunk in request.stream():
                size += len(chunk)
                if size > limit:
                    raise HTTPException(status_code=413, detail="the file is too big (4 GB max)")
                f.write(chunk)
        if not size:
            raise HTTPException(status_code=422, detail="the file is empty")
        tmp.replace(target)
    finally:
        tmp.unlink(missing_ok=True)
    if parts and parts[0] == "sound-effects" and ext in T.AUDIO_EXTS:      # keep it for every other project too
        try:
            SOUND_LIBRARY.mkdir(parents=True, exist_ok=True)
            lib = SOUND_LIBRARY / Path(*parts[1:]) / target.name if len(parts) > 1 else SOUND_LIBRARY / target.name
            lib.parent.mkdir(parents=True, exist_ok=True)
            if not lib.exists():
                try:
                    os.link(target, lib)
                except OSError:
                    shutil.copy2(target, lib)
        except OSError:
            pass
    return {"src": target.relative_to(d / "public").as_posix(), "name": target.name,
            "kind": "image" if ext in T.IMAGE_EXTS else "video" if ext in T.VIDEO_EXTS else "audio"}


class StillBody(BaseModel):
    t: float   # seconds on the montage clock (after the opener)


@router.post("/{project_id}/still")
async def still_image(project_id: str, body: StillBody) -> FileResponse:
    """One frame of the saved timeline at second t, as a PNG (clip + its own text only)."""
    from backlot import quick_export
    d = _project_dir(project_id)
    path = T.timeline_path(d)
    if not path.exists():
        raise HTTPException(status_code=404, detail="no timeline yet")
    tl = await asyncio.to_thread(T.load, path)
    at, hit, start = 0.0, None, 0.0
    for c in tl["clips"]:
        ln = (float(c.get("hold") or 2.5) if c.get("kind") == "image"
              else (float(c["out"]) - float(c.get("in") or 0)) / float(c.get("speed") or 1))
        hit, start = c, at
        if body.t < at + ln:
            break
        at += ln
    if hit is None:
        raise HTTPException(status_code=422, detail="the timeline has no clips")
    keep = hit["id"]
    tl["clips"] = [hit]
    tl["texts"] = [x for x in tl.get("texts") or [] if x.get("follow") == keep]
    tl["layers"], tl["music"], tl["music_more"], tl["opener"] = [], None, [], None
    out = d / "renders" / f"still-{time.strftime('%Y%m%d-%H%M%S')}.png"
    out.parent.mkdir(exist_ok=True)
    try:
        await asyncio.to_thread(quick_export.export, d, tl, out, lambda *_: None, max(0.0, body.t - start))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    name = re.sub(r"[^\w\- ]+", "", tl.get("title") or project_id).strip() or project_id
    return FileResponse(out, media_type="image/png", filename=f"{name} {body.t:.1f}s.png")


class RenameBody(BaseModel):
    title: str


def _write_marker(d: Path, **changes: Any) -> None:
    path = d / "project.json"
    marker = json.loads(path.read_text("utf-8")) if path.is_file() else {}
    for k, v in changes.items():
        if v is None:
            marker.pop(k, None)
        else:
            marker[k] = v
    path.write_text(json.dumps(marker, indent=2, ensure_ascii=False), "utf-8")
    from backlot.server import _invalidate_summary
    _invalidate_summary(d.name)


@router.post("/{project_id}/rename")
async def rename_project(project_id: str, body: RenameBody) -> dict:
    """Change the name shown in the Library (the folder id stays the same)."""
    d = _project_dir(project_id)
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="the name cannot be empty")
    await asyncio.to_thread(_write_marker, d, title=title)
    tl_path = T.timeline_path(d)
    if tl_path.exists():
        tl = await asyncio.to_thread(T.load, tl_path)
        tl["title"] = title
        await asyncio.to_thread(lambda: T.save(tl_path, tl, merge_comments=False))
    return {"ok": True, "title": title}


@router.post("/{project_id}/cover")
async def set_cover(project_id: str, request: Request) -> dict:
    """Upload a cover photo (raw image bytes in the body). Empty body = back to automatic."""
    d = _project_dir(project_id)
    data = await request.body()
    for old in d.glob("cover.*"):
        old.unlink()
    if not data:
        await asyncio.to_thread(_write_marker, d, cover=None, cover_v=None)
        return {"ok": True, "cover": None}
    if len(data) > 15_000_000:
        raise HTTPException(status_code=413, detail="the photo is too big (15 MB max)")
    from io import BytesIO
    from PIL import Image
    try:
        with Image.open(BytesIO(data)) as img:
            img = img.convert("RGB")
            img.thumbnail((1600, 1600))
            img.save(d / "cover.jpg", "JPEG", quality=88)
    except Exception:
        raise HTTPException(status_code=422, detail="that file is not a photo")
    await asyncio.to_thread(_write_marker, d, cover="cover.jpg", cover_v=int(time.time()))
    return {"ok": True, "cover": "cover.jpg"}


def _scan_media(folder: Path) -> list[Path]:
    exts = T.VIDEO_EXTS | T.IMAGE_EXTS
    return sorted(
        (p for p in folder.rglob("*")
         if p.is_file() and p.suffix.lower() in exts
         and not any(x.startswith(".") or x.endswith("_frames") or x in ("source-review", "stills")
                     for x in p.relative_to(folder).parts[:-1])),
        key=lambda p: p.relative_to(folder).as_posix().lower(),
    )


_QUIET_TYPES = {"", ".ds_store", ".json", ".txt", ".srt", ".md", ".csv", ".pdf", ".plist", ".py", ".xlsx", ".docx"}


def _ignored_types(folder: Path) -> dict[str, int]:
    """File types in the folder that the importer does not take (so the user is told, not left guessing)."""
    ok = T.VIDEO_EXTS | T.IMAGE_EXTS
    out: dict[str, int] = {}
    for p in folder.rglob("*"):
        if p.is_file() and not p.name.startswith(".") and p.suffix.lower() not in ok and p.suffix.lower() not in _QUIET_TYPES:
            out[p.suffix.lower()] = out.get(p.suffix.lower(), 0) + 1
    return dict(sorted(out.items(), key=lambda kv: -kv[1])[:6])


def _fmt_types(types: dict[str, int]) -> str:
    return ", ".join(f"{n} {e or '(no extension)'}" for e, n in types.items())


def _import_files(files: list[Path], dest: Path, base: Optional[Path] = None) -> int:
    """Hard-link (or copy) photos/videos into dest, never overwriting. With ``base`` the sub-folder layout under it is kept
    (cut-clips/, b-roll/ ...); same name -> name-2.ext."""
    dest.mkdir(parents=True, exist_ok=True)
    n = 0
    for src in files:
        rel = src.relative_to(base) if base is not None else Path(src.name)
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        k = 2
        while target.exists():
            if target.stat().st_size == src.stat().st_size:
                target = None  # already imported
                break
            target = dest / rel.parent / f"{rel.stem}-{k}{rel.suffix}"
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


_WAVE_DIR = REPO_ROOT / ".backlot" / "wave"
_wave_busy: set[str] = set()
WAVE_PER_SEC = 20


def _wave_compute(src: Path, out: Path) -> None:
    import numpy as np
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(src), "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
                       capture_output=True)
    pcm = np.frombuffer(r.stdout, dtype=np.int16).astype(np.float32) / 32768.0 if r.returncode == 0 else np.zeros(0, np.float32)
    step = 8000 // WAVE_PER_SEC
    n = len(pcm) // step
    peaks = (np.abs(pcm[: n * step]).reshape(n, step).max(axis=1) if n else np.zeros(0))
    # sound is heard on a log scale, so a quiet voice still draws a visible wave
    peaks = np.clip((np.log10(np.maximum(peaks, 1e-4)) + 3.2) / 3.2, 0, 1)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".part")
    tmp.write_text(json.dumps({"per_sec": WAVE_PER_SEC, "peaks": [int(v * 100) for v in peaks]}))
    tmp.replace(out)


@router.get("/{project_id}/waveform")
async def waveform(project_id: str, src: str) -> dict:
    """Loudness over time of a video or song (20 values a second, 0 to 100) for the picture of the sound wave on the timeline."""
    d = _project_dir(project_id)
    pub = (d / "public").resolve()
    f = (pub / src).resolve()
    if pub not in f.parents or not f.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    key = hashlib.sha1(f"{f}:{f.stat().st_mtime_ns}:{f.stat().st_size}".encode()).hexdigest()
    out = _WAVE_DIR / f"{key}.json"
    if out.is_file():
        return {"ready": True, **json.loads(out.read_text())}
    if key not in _wave_busy:
        _wave_busy.add(key)

        def work() -> None:
            try:
                _wave_compute(f, out)
            finally:
                _wave_busy.discard(key)
        threading.Thread(target=work, daemon=True).start()
    return {"ready": False}


class ReverseBody(BaseModel):
    src: str            # relative to the project's public/ folder
    start: float = 0
    end: float


@router.post("/{project_id}/reverse")
async def reverse_clip(project_id: str, body: ReverseBody) -> dict:
    """Make a backwards copy of src[start:end] (picture and sound) in public/reversed/. The player cannot play backwards, so Reverse is a real file."""
    d = _project_dir(project_id)
    pub = (d / "public").resolve()
    src = (pub / body.src).resolve()
    if pub not in src.parents or not src.is_file():
        raise HTTPException(status_code=404, detail="video not found")
    if not 0 <= body.start < body.end or body.end - body.start > 180:
        raise HTTPException(status_code=422, detail="Reverse works on clips up to 3 minutes. Split the clip first.")
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", src.stem)[:40]
    out = pub / "reversed" / f"{stem}-{body.start:.2f}-{body.end:.2f}.mp4"

    def work() -> None:
        if out.is_file():
            return
        out.parent.mkdir(exist_ok=True)
        tmp = out.with_suffix(".part.mp4")
        has_a = T.probe_has_audio(src)
        cmd = ["ffmpeg", "-v", "error", "-y", "-ss", str(body.start), "-to", str(body.end), "-i", str(src),
               "-vf", "reverse,fps=30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
        cmd += ["-af", "areverse", "-c:a", "aac", "-b:a", "128k"] if has_a else ["-an"]
        r = subprocess.run(cmd + ["-movflags", "+faststart", str(tmp)], capture_output=True, text=True)
        if r.returncode != 0 or not tmp.is_file():
            tmp.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"reverse failed: {r.stderr.strip()[-300:]}")
        tmp.replace(out)

    await asyncio.to_thread(work)
    return {"src": out.relative_to(pub).as_posix(), "duration": T.probe_duration(out) or body.end - body.start}


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
    ignored = await asyncio.to_thread(_ignored_types, folder)
    if not files:
        more = f" It has: {_fmt_types(ignored)}." if ignored else " The folder looks empty."
        raise HTTPException(status_code=422, detail=f"No supported photos or videos in {folder.name}/ (mp4, mov, m4v, webm, mkv, jpg, png, webp).{more}")
    # keep the folder (and its sub-folders) so the bin can show "cut clips", "b-roll" ... separately
    added = await asyncio.to_thread(_import_files, files, d / "public" / "media" / folder.name, folder)
    _save_link(d, folder.name, folder)
    return {"found": len(files), "added": added, "ignored": ignored, "folder": folder.name}


# The media bin holds hard-linked copies of imported folders. media_links.json remembers where each one came from,
# so "Refresh" can bring in files that were added to the original folder later.
SOUND_LIBRARY = REPO_ROOT / "assets" / "sound_effects"     # shared by every project: files in here appear in each project's "Sound effects" folder


def _link_sound_library(d: Path) -> int:
    """Point this project's sound-effects folder at the shared library and bring its files in (hard links, no extra disk)."""
    if not SOUND_LIBRARY.is_dir():
        return 0
    _save_link(d, "sound-effects", SOUND_LIBRARY)
    files = [f for f in SOUND_LIBRARY.rglob("*") if f.is_file() and f.suffix.lower() in T.AUDIO_EXTS]
    return _import_files(files, d / "public" / "media" / "sound-effects", SOUND_LIBRARY)


def _links_path(d: Path) -> Path:
    return d / "media_links.json"


def _load_links(d: Path) -> dict[str, str]:
    try:
        return json.loads(_links_path(d).read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def _load_skips(d: Path) -> list[str]:
    try:
        return json.loads((d / "media_skip.json").read_text("utf-8"))
    except (OSError, ValueError):
        return []


class FolderBody(BaseModel):
    folder: str          # path inside public/media, as the media panel shows it (for example "cuts-bank/1_says_Growee")


@router.post("/{project_id}/folder/remove")
async def remove_folder(project_id: str, body: FolderBody) -> dict:
    """Take a folder out of the media bin. Nothing is deleted for good: it moves to the project's trash folder, and Refresh will not bring it back."""
    d = _project_dir(project_id)
    parts = [x for x in body.folder.replace("\\", "/").split("/") if x and x not in (".", "..")]
    if not parts:
        raise HTTPException(status_code=422, detail="pick a folder")
    media = (d / "public" / "media").resolve()
    target = (media / Path(*parts)).resolve()
    if media not in target.parents or not target.is_dir():
        raise HTTPException(status_code=404, detail="folder not found")
    rel = target.relative_to(media).as_posix()
    # refuse while the timeline still uses a file from it (it would go black)
    tl_path = T.timeline_path(d)
    used = 0
    if tl_path.exists():
        tl = await asyncio.to_thread(T.load, tl_path)
        srcs = [c.get("src") for c in tl.get("clips", [])] + [l.get("src") for l in tl.get("layers", [])]
        srcs += [m.get("src") for m in ([tl.get("music")] if tl.get("music") else []) + (tl.get("music_more") or [])]
        used = sum(1 for x in srcs if x and (x.startswith(f"media/{rel}/")))
    if used:
        raise HTTPException(status_code=409, detail=f"{used} file{'s' if used > 1 else ''} from this folder {'are' if used > 1 else 'is'} used on the timeline. Remove {'them' if used > 1 else 'it'} from the timeline first.")
    n = sum(1 for f in target.rglob("*") if f.is_file())
    trash = d / "trash" / f"{rel.replace('/', '__')}-{time.strftime('%Y%m%d-%H%M%S')}"
    trash.parent.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(shutil.move, str(target), str(trash))
    skips = _load_skips(d)
    if rel not in skips:
        skips.append(rel)
        (d / "media_skip.json").write_text(json.dumps(skips, indent=2, ensure_ascii=False), "utf-8")
    return {"removed": rel, "files": n, "kept_in": trash.relative_to(d).as_posix()}


class MediaFileBody(BaseModel):
    src: str             # path inside public/, as the media list shows it (for example "media/sound-effects/pop.wav")


@router.post("/{project_id}/media/remove")
async def remove_media_file(project_id: str, body: MediaFileBody) -> dict:
    """Take one file out of the media bin (moved to the project's trash, not erased; Refresh will not bring it back)."""
    d = _project_dir(project_id)
    public = (d / "public").resolve()
    target = (public / body.src).resolve()
    if public not in target.parents or not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    tl_path = T.timeline_path(d)
    if tl_path.exists():
        tl = await asyncio.to_thread(T.load, tl_path)
        srcs = [c.get("src") for c in tl.get("clips", [])] + [l.get("src") for l in tl.get("layers", [])]
        srcs += [m.get("src") for m in ([tl.get("music")] if tl.get("music") else []) + (tl.get("music_more") or [])]
        if body.src in srcs:
            raise HTTPException(status_code=409, detail="this file is used on the timeline. Remove it from the timeline first.")
    rel = target.relative_to(public).as_posix()
    trash = d / "trash" / "files" / f"{time.strftime('%Y%m%d-%H%M%S')}-{target.name}"
    trash.parent.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(shutil.move, str(target), str(trash))
    if rel.startswith("media/"):
        skips = _load_skips(d)
        if rel[6:] not in skips:
            skips.append(rel[6:])
            (d / "media_skip.json").write_text(json.dumps(skips, indent=2, ensure_ascii=False), "utf-8")
    return {"removed": rel, "kept_in": trash.relative_to(d).as_posix()}


def _save_link(d: Path, name: str, source: Path) -> None:
    links = _load_links(d)
    links[name] = str(source)
    _links_path(d).write_text(json.dumps(links, indent=2, ensure_ascii=False), "utf-8")


@router.post("/{project_id}/sync-links")
async def sync_links(project_id: str) -> dict:
    """Bring new files from the original folders (Finder) into the media bin. Only adds; never deletes or overwrites."""
    d = _project_dir(project_id)

    def run() -> dict:
        added, per, missing = 0, {}, []
        for name, src in _load_links(d).items():
            folder = Path(src)
            if not folder.is_dir():
                missing.append(name)
                continue
            skip = _load_skips(d)
            def wanted(f: Path) -> bool:
                if any(x.startswith("_") for x in f.relative_to(folder).parts[:-1]):
                    return False
                rel = (Path(name) / f.relative_to(folder)).as_posix()      # the file, then each folder above it
                return not any(rel == k or rel.startswith(k + "/") for k in skip)
            files = [f for f in _scan_media(folder) if wanted(f)]
            n = _import_files(files, d / "public" / "media" / name, folder)
            if n:
                per[name] = n
            added += n
        return {"added": added, "folders": per, "missing": missing, "linked": len(_load_links(d))}

    return await asyncio.to_thread(run)


@router.post("/pick-folder")
async def pick_folder() -> dict:
    """Open the macOS folder picker on this Mac (the server runs locally) and return the chosen path."""
    if sys.platform != "darwin" or not shutil.which("osascript"):
        raise HTTPException(status_code=501, detail="The folder picker only works on a Mac. Copy the media into the project's public/media folder instead.")
    script = 'tell me to activate\nPOSIX path of (choose folder with prompt "Pick a folder with photos and videos")'
    try:
        res = await asyncio.to_thread(lambda: subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=600))
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=408, detail="No folder was chosen in time")
    if res.returncode != 0:
        if "-128" in res.stderr:                    # the user pressed Cancel
            return {"cancelled": True}
        raise HTTPException(status_code=500, detail=res.stderr.strip()[-300:] or "could not open the folder picker")
    return {"path": res.stdout.strip()}


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
