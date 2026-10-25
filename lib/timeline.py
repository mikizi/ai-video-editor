"""Montage timeline: the single, editable source of truth for a montage edit.

A timeline (``projects/<id>/artifacts/timeline.json``) holds the whole edit as
data: clip order, trims, speed, transitions, motion, text and music.  It is
rendered by the reusable Remotion composition ``FamilyMontage`` (see
``remotion-composer/src/montage/``) and edited by agents or by the Backlot
timeline editor.  No per-project TSX is needed.

All media paths are relative to the project's ``public/`` directory.

The layout math here MUST stay identical to
``remotion-composer/src/montage/layout.ts`` (covered by tests).
"""

from __future__ import annotations

import copy
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Optional

import jsonschema

from schemas.artifacts import load_schema

DEFAULT_IMAGE_HOLD = 2.5
DEFAULT_TRANSITION_SECONDS = 0.35
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".ogg"}

FORMATS = {
    "9:16": {"width": 1080, "height": 1920},
    "16:9": {"width": 1920, "height": 1080},
    "1:1": {"width": 1080, "height": 1080},
    "4:5": {"width": 1080, "height": 1350},
}


class TimelineError(ValueError):
    """Raised when a timeline is structurally valid JSON but makes no sense."""


# ---------------------------------------------------------------------------
# Paths, load / save / validate
# ---------------------------------------------------------------------------

def timeline_path(project_dir: Path | str) -> Path:
    return Path(project_dir) / "artifacts" / "timeline.json"


def validate(tl: dict[str, Any]) -> None:
    """Schema validation plus semantic checks. Raises on the first problem."""
    jsonschema.validate(instance=tl, schema=load_schema("timeline"))
    seen: set[str] = set()
    for clip in tl["clips"]:
        cid = clip["id"]
        if cid in seen:
            raise TimelineError(f"duplicate clip id: {cid}")
        seen.add(cid)
        if clip["kind"] == "video":
            if "out" not in clip:
                raise TimelineError(f"video clip {cid} needs 'out'")
            if clip["out"] <= clip.get("in", 0):
                raise TimelineError(f"video clip {cid}: out must be greater than in")
            src_dur = clip.get("source_duration")
            if src_dur is not None and clip["out"] > src_dur + 0.05:
                raise TimelineError(f"video clip {cid}: out ({clip['out']}) is past the end of the source ({src_dur})")
    for text in tl.get("texts", []):
        if text["end"] <= text["start"]:
            raise TimelineError(f"text {text['id']}: end must be greater than start")


def load(path: Path | str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        tl = json.load(f)
    validate(tl)
    return tl


def _merge_comments(path: Path, tl: dict[str, Any]) -> None:
    """Keep review notes safe from a stale writer.

    A script (or an editor tab) that loaded the timeline minutes ago must not wipe the approvals / replies / new notes
    that were saved in between.  Per note id the newer `updated` stamp wins; notes that exist only on disk are kept.
    """
    try:
        disk = json.loads(path.read_text(encoding="utf-8")).get("comments") or []
    except (OSError, ValueError):
        return
    if not disk:
        return
    mine = {c["id"]: c for c in tl.get("comments") or []}
    for d in disk:
        m = mine.get(d["id"])
        if m is None:
            mine[d["id"]] = d
        elif (d.get("updated") or "") > (m.get("updated") or ""):
            mine[d["id"]] = d
    order = {c["id"]: i for i, c in enumerate(disk)}
    merged = sorted(mine.values(), key=lambda c: order.get(c["id"], 10**6))
    tl["comments"] = merged


def save(path: Path | str, tl: dict[str, Any], merge_comments: bool = True) -> Path:
    """Validate, then write atomically (temp file + rename)."""
    path = Path(path)
    if merge_comments and path.exists():
        _merge_comments(path, tl)
    validate(tl)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".timeline-", suffix=".json", dir=path.parent)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(tl, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)
    return path


# ---------------------------------------------------------------------------
# Layout math (mirrors remotion-composer/src/montage/layout.ts)
# ---------------------------------------------------------------------------

def clip_seconds(clip: dict[str, Any]) -> float:
    """How long a clip stays on the timeline, in seconds."""
    if clip["kind"] == "image":
        return float(clip.get("hold", DEFAULT_IMAGE_HOLD))
    speed = float(clip.get("speed", 1) or 1)
    return (float(clip["out"]) - float(clip.get("in", 0))) / speed


def _transition_seconds(trans: Optional[dict[str, Any]], prev_len: float, this_len: float) -> float:
    if not trans or trans.get("type", "cut") in ("cut", "shutter"):
        return 0.0
    want = float(trans.get("seconds", DEFAULT_TRANSITION_SECONDS))
    return max(0.0, min(want, prev_len / 2.0, this_len / 2.0))


def layout(tl: dict[str, Any]) -> dict[str, Any]:
    """Compute where every clip sits on the global timeline.

    Transitions overlap the two clips (like CapCut), so the total is the sum of
    clip lengths minus the transition lengths.  The opener (if any) comes first;
    clip 1's transition is only used when there is an opener before it.
    """
    opener = tl.get("opener")
    opener_s = float(opener["seconds"]) if opener else 0.0
    items = []
    cursor = opener_s
    prev_len = opener_s
    for i, clip in enumerate(tl["clips"]):
        length = clip_seconds(clip)
        has_prev = i > 0 or opener_s > 0
        t = _transition_seconds(clip.get("transition"), prev_len, length) if has_prev else 0.0
        start = cursor - t
        # A pinned (locked) clip keeps its time: a gap opens instead of it shifting.
        if clip.get("at") is not None and float(clip["at"]) >= cursor - 1e-6:
            start = float(clip["at"])
            t = 0.0
        items.append({
            "id": clip["id"],
            "start": round(start, 4),
            "duration": round(length, 4),
            "end": round(start + length, 4),
            "transition_seconds": round(t, 4),
        })
        cursor = start + length
        prev_len = length
    return {
        "opener_seconds": opener_s,
        "items": items,
        "total_seconds": round(max(cursor, opener_s), 4),
    }


def total_seconds(tl: dict[str, Any]) -> float:
    return layout(tl)["total_seconds"]


# ---------------------------------------------------------------------------
# Edits used by agents and the GUI
# ---------------------------------------------------------------------------

def snap_to_beats(tl: dict[str, Any], tolerance: float = 0.4) -> dict[str, Any]:
    """Return a copy where every clip END lands on the nearest beat.

    Beats are on the montage clock (0 = first moment after the opener).  Only
    clips whose end is within ``tolerance`` seconds of a beat are changed.
    Videos change their ``out`` point (bounded by the source length), images
    change ``hold``.
    """
    beats = sorted(tl.get("beats") or [])
    out = copy.deepcopy(tl)
    if not beats:
        return out
    for clip in out["clips"]:
        lay = {it["id"]: it for it in layout(out)["items"]}
        it = lay[clip["id"]]
        end_m = it["end"] - layout(out)["opener_seconds"]
        nearest = min(beats, key=lambda b: abs(b - end_m))
        delta = nearest - end_m
        if abs(delta) > tolerance or abs(delta) < 1e-3:
            continue
        if clip["kind"] == "image":
            clip["hold"] = round(max(0.3, clip_seconds(clip) + delta), 3)
        else:
            speed = float(clip.get("speed", 1) or 1)
            new_out = float(clip["out"]) + delta * speed
            limit = clip.get("source_duration")
            if limit is not None:
                new_out = min(new_out, float(limit))
            if new_out - float(clip.get("in", 0)) > 0.3:
                clip["out"] = round(new_out, 3)
    return out


def move_clip(tl: dict[str, Any], clip_id: str, new_index: int) -> dict[str, Any]:
    out = copy.deepcopy(tl)
    idx = next(i for i, c in enumerate(out["clips"]) if c["id"] == clip_id)
    clip = out["clips"].pop(idx)
    out["clips"].insert(max(0, min(new_index, len(out["clips"]))), clip)
    return out


# ---------------------------------------------------------------------------
# Draft builder: a folder of photos/videos -> a first timeline
# ---------------------------------------------------------------------------

def probe_duration(path: Path) -> Optional[float]:
    try:
        res = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        return float(res.stdout.strip())
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def _natural_key(name: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


_TRANSITION_CYCLE = ["flash", "zoom", "whip", "fade", "slide-left", "zoom", "flash", "slide-up"]
_IMAGE_MOTIONS = ["zoom-in", "pan-left", "zoom-out", "pan-right"]


def draft_from_media(
    project_dir: Path | str,
    media_subdir: str = "media",
    aspect: str = "9:16",
    video_window: float = 3.0,
    image_hold: float = 2.2,
    title: Optional[str] = None,
    highlights: Optional[dict[str, tuple[float, float]]] = None,
) -> dict[str, Any]:
    """Build a lively first-draft timeline from ``public/<media_subdir>/``.

    Files are ordered by name (phone names sort by capture time).  Each video
    gets a ``video_window``-second window - the middle of the clip, or the
    window given in ``highlights[filename] = (in, out)``.  Photos get a slow
    Ken-Burns move.  Transitions rotate through a punchy set.
    """
    project_dir = Path(project_dir)
    public = project_dir / "public"
    media_dir = public / media_subdir
    if not media_dir.is_dir():
        raise FileNotFoundError(f"no media folder: {media_dir}")
    highlights = highlights or {}

    files = sorted(
        (p for p in media_dir.iterdir() if p.suffix.lower() in VIDEO_EXTS | IMAGE_EXTS),
        key=lambda p: _natural_key(p.name),
    )
    clips: list[dict[str, Any]] = []
    for n, p in enumerate(files):
        rel = f"{media_subdir}/{p.name}"
        cid = f"c{n + 1:02d}"
        trans = {"type": _TRANSITION_CYCLE[n % len(_TRANSITION_CYCLE)], "seconds": 0.3}
        if p.suffix.lower() in VIDEO_EXTS:
            dur = probe_duration(p) or video_window
            if p.name in highlights:
                a, b = highlights[p.name]
            else:
                win = min(video_window, dur)
                a = max(0.0, (dur - win) / 2.0)
                b = a + win
            clips.append({
                "id": cid, "src": rel, "kind": "video", "label": p.stem,
                "in": round(a, 3), "out": round(min(b, dur), 3), "source_duration": round(dur, 3),
                "speed": 1, "volume": 0, "fit": "cover", "motion": "punch", "transition": trans,
            })
        else:
            clips.append({
                "id": cid, "src": rel, "kind": "image", "label": p.stem, "hold": image_hold,
                "fit": "cover", "motion": _IMAGE_MOTIONS[n % len(_IMAGE_MOTIONS)], "transition": trans,
            })

    opener = None
    brand = public / "brand" / "brand-opener.mp4"
    if brand.exists():
        # The opener is 16:9; in a vertical video "cover" makes the logo big instead of a thin strip.
        fit = "cover" if FORMATS[aspect]["height"] > FORMATS[aspect]["width"] else "contain"
        opener = {"src": "brand/brand-opener.mp4", "seconds": 4.0, "fit": fit}

    music = None
    music_dir = public / "music"
    if music_dir.is_dir():
        tracks = sorted(p for p in music_dir.iterdir() if p.suffix.lower() in AUDIO_EXTS)
        if tracks:
            music = {"src": f"music/{tracks[0].name}", "offset": 0, "volume": 0.8,
                     "duck_volume": 0.25, "fade_in": 0.5, "fade_out": 2.0, "start_at": "clips"}

    tl: dict[str, Any] = {
        "version": "1.0",
        "title": title or project_dir.name,
        "format": {**FORMATS[aspect], "fps": 30},
        "style": {"font": "Heebo", "accent": "#FFD400", "grade": "warm", "vignette": True,
                  "beat_pulse": 0.0, "background": "#000000"},
        "opener": opener,
        "clips": clips,
        "texts": [],
        "music": music,
        "beats": [],
    }
    validate(tl)
    return tl


def to_remotion_props(tl: dict[str, Any]) -> dict[str, Any]:
    return {"timeline": tl}
