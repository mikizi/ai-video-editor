"""Beat detection for the montage's song (HyperFrames ``beats``), cached per project.

``detect_song_beats`` works on the song's own clock.  ``to_montage_clock`` maps those
beats onto the montage clock that ``timeline.json["beats"]`` uses (0 = first moment
after the opener), taking the song start offset and ``start_at`` into account.
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Optional

from lib.paths import REPO_ROOT


class BeatError(RuntimeError):
    pass


def _cache_path(project_dir: Path, music_src: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", music_src)
    return project_dir / "artifacts" / "beats" / f"{safe}.json"


def _fingerprint(audio: Path) -> str:
    st = audio.stat()
    return f"{st.st_size}-{st.st_mtime_ns}"


def cached_beats(project_dir: Path | str, music_src: str) -> Optional[dict[str, Any]]:
    """The saved detection for this song, or None if there is none (or the file changed)."""
    project_dir = Path(project_dir)
    audio = project_dir / "public" / music_src
    cache = _cache_path(project_dir, music_src)
    if not audio.is_file() or not cache.is_file():
        return None
    try:
        data = json.loads(cache.read_text(encoding="utf-8"))
    except ValueError:
        return None
    return data if data.get("fingerprint") == _fingerprint(audio) else None


def detect_song_beats(project_dir: Path | str, music_src: str, force: bool = False) -> dict[str, Any]:
    """Return {bpm, count, times, strengths} on the song clock. Runs HyperFrames once, then caches."""
    project_dir = Path(project_dir)
    audio = project_dir / "public" / music_src
    if not audio.is_file():
        raise BeatError(f"song not found: {music_src}")
    if not force:
        hit = cached_beats(project_dir, music_src)
        if hit:
            return hit

    with tempfile.TemporaryDirectory(prefix="beats-") as tmp:
        work = Path(tmp)
        name = "song" + audio.suffix.lower()
        (work / name).symlink_to(audio.resolve())
        # HyperFrames wants a composition with a music-role <audio>; this is a throwaway one.
        (work / "index.html").write_text(
            '<!doctype html><html><head><meta charset="UTF-8"/></head><body>'
            '<div id="root" data-composition-id="main" data-width="1080" data-height="1920" data-duration="10">'
            f'<audio id="music" data-timeline-role="music" src="{name}" data-start="0" data-duration="10" data-track-index="0"></audio>'
            "</div><script>window.__timelines={main:{duration:()=>10}}</script></body></html>",
            encoding="utf-8",
        )
        res = subprocess.run(["npx", "--yes", "hyperframes", "beats", str(work), "--json"],
                             cwd=REPO_ROOT, capture_output=True, text=True, timeout=600)
        out = work / "beats" / f"{name}.json"
        if res.returncode != 0 or not out.exists():
            raise BeatError(f"beat detection failed:\n{(res.stdout + res.stderr)[-800:]}")
        raw = json.loads(out.read_text(encoding="utf-8"))
        bpm = None
        try:
            bpm = json.loads(res.stdout[res.stdout.index("{"):]).get("bpm")
        except (ValueError, json.JSONDecodeError):
            pass

    beats = sorted(raw.get("beats", []), key=lambda b: b["time"])
    data = {
        "src": music_src,
        "bpm": bpm,
        "count": len(beats),
        "times": [round(float(b["time"]), 3) for b in beats],
        "strengths": [round(float(b.get("strength", 0)), 3) for b in beats],
        "fingerprint": _fingerprint(audio),
    }
    cache = _cache_path(project_dir, music_src)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(data), encoding="utf-8")
    return data


def to_montage_clock(times: list[float], music: dict[str, Any], opener_seconds: float, total: float) -> list[float]:
    """Song-clock beats -> montage clock (0 = just after the opener), limited to the video length."""
    shift = float(music.get("offset", 0) or 0)
    if music.get("start_at") == "opener":
        shift += opener_seconds  # the song starts under the opener, so the montage starts later in the song
    shift -= float(music.get("shift", 0) or 0)  # moved on the timeline: later start = beats later
    return [round(t - shift, 3) for t in times if 0 <= t - shift <= total]
