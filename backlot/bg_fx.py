"""Background effects for one clip: blur the background, or replace it (colour / photo / video).

The person is found frame by frame with MediaPipe selfie segmentation (runs on the Mac, free).
The result is a new MP4 for just the clip's cut; the timeline clip is pointed at it and the
original cut is kept in clip["bgfx"]["orig"] so the effect can be changed or removed.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, Callable, Optional

import numpy as np


def _probe(path: Path) -> tuple[int, int, float]:
    import json
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate",
                        "-of", "json", str(path)], capture_output=True, text=True)
    s = json.loads(r.stdout)["streams"][0]
    n, d = s["r_frame_rate"].split("/")
    return int(s["width"]), int(s["height"]), (float(n) / float(d) if float(d) else 30.0)


def _has_audio(path: Path) -> bool:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)],
                       capture_output=True, text=True)
    return bool(r.stdout.strip())


def _reader(path: Path, start: float, dur: float, w: int, h: int, fps: float, loop: bool = False):
    cmd = ["ffmpeg", "-v", "error"]
    if loop:
        cmd += ["-stream_loop", "-1"]
    cmd += ["-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(path), "-vf", f"fps={fps},scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}",
            "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


def _read_frame(p: subprocess.Popen, w: int, h: int) -> Optional[np.ndarray]:
    buf = p.stdout.read(w * h * 3)  # type: ignore[union-attr]
    if len(buf) < w * h * 3:
        return None
    return np.frombuffer(buf, np.uint8).reshape(h, w, 3)


def render(src: Path, start: float, end: float, out: Path, mode: str, amount: float, color: str, backdrop: Optional[Path],
           progress: Callable[[float], None]) -> None:
    import cv2
    import mediapipe as mp

    w, h, fps = _probe(src)
    w, h = w - w % 2, h - h % 2
    dur = max(0.1, end - start)
    total = max(1, int(dur * fps))
    sigma = max(0.1, float(amount) / 100.0 * 0.03 * h)   # 100% = 3% of the frame height
    bg_const = None
    if mode == "color":
        c = color.lstrip("#")
        rgb = tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
        bg_const = np.full((h, w, 3), rgb[::-1], np.uint8)
    bg_reader = None
    bg_still = None
    if mode == "image" and backdrop:
        if backdrop.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
            img = cv2.imread(str(backdrop))
            if img is None:
                raise RuntimeError("could not read the background picture")
            sc = max(w / img.shape[1], h / img.shape[0])
            img = cv2.resize(img, (int(img.shape[1] * sc) + 1, int(img.shape[0] * sc) + 1))
            y0, x0 = (img.shape[0] - h) // 2, (img.shape[1] - w) // 2
            bg_still = img[y0:y0 + h, x0:x0 + w]
        else:
            bg_reader = _reader(backdrop, 0, dur, w, h, fps, loop=True)

    inp = _reader(src, start, dur, w, h, fps)
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", f"{fps}", "-i", "-"]
    if _has_audio(src):
        cmd += ["-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(src), "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "192k"]
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-shortest", str(out)]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    seg = mp.solutions.selfie_segmentation.SelfieSegmentation(model_selection=0)
    prev = None
    n = 0
    try:
        while True:
            frame = _read_frame(inp, w, h)
            if frame is None:
                break
            m = seg.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)).segmentation_mask
            m = cv2.resize(m, (w, h))
            m = np.clip((m - 0.35) / 0.3, 0, 1)                 # firm edge, a little softness
            m = cv2.GaussianBlur(m, (0, 0), max(1.0, h / 400))
            prev = m if prev is None else 0.5 * prev + 0.5 * m   # steadier between frames
            m = prev[..., None]
            if mode == "blur":
                back = cv2.GaussianBlur(frame, (0, 0), sigma)
            elif bg_const is not None:
                back = bg_const
            elif bg_still is not None:
                back = bg_still
            elif bg_reader is not None:
                back = _read_frame(bg_reader, w, h)
                if back is None:
                    back = frame
            else:
                back = frame
            comp = (frame * m + back * (1 - m)).astype(np.uint8)
            enc.stdin.write(comp.tobytes())  # type: ignore[union-attr]
            n += 1
            if n % 10 == 0:
                progress(min(0.99, n / total))
    finally:
        seg.close()
        inp.stdout.close()  # type: ignore[union-attr]
        if bg_reader:
            bg_reader.kill()
        enc.stdin.close()  # type: ignore[union-attr]
        err = enc.stderr.read().decode()[-800:] if enc.stderr else ""
        rc = enc.wait()
    if rc != 0 or not out.is_file():
        raise RuntimeError(err or "ffmpeg failed")


def apply(project_dir: Path, project_id: str, clip: dict[str, Any], fx: dict[str, Any], progress: Callable[[float], None]) -> dict[str, Any]:
    """Make the processed file and return the clip fields to change (src/in/out/source_duration/dim/bgfx)."""
    pub = project_dir / "public"
    old = clip.get("bgfx") or {}
    orig = old.get("orig") or {k: clip.get(k) for k in ("src", "in", "out", "source_duration", "dim", "speed") if clip.get(k) is not None}
    mode = fx.get("mode") or "none"
    if mode == "none":
        return {**{k: v for k, v in orig.items() if k != "speed"}, "bgfx": None}
    src = pub / orig["src"]
    if not src.is_file():
        raise RuntimeError("the original video file is missing")
    if mode not in ("blur", "color", "image"):
        raise RuntimeError(f"unknown background effect: {mode}")
    backdrop = None
    if mode == "image":
        backdrop = pub / str(fx.get("image") or "")
        if not backdrop.is_file():
            raise RuntimeError("the background picture or video was not found in the media bin")
    start, end = float(orig.get("in") or 0), float(orig["out"])
    import hashlib
    key = hashlib.sha1(f"{orig['src']}|{start}|{end}|{mode}|{fx.get('amount')}|{fx.get('color')}|{fx.get('image')}".encode()).hexdigest()[:10]
    outdir = pub / "media" / "fx"
    outdir.mkdir(parents=True, exist_ok=True)
    out = outdir / f"{clip['id']}-{key}.mp4"
    if not out.is_file():
        tmp = out.with_suffix(".part.mp4")
        render(src, start, end, tmp, mode, float(fx.get("amount") if fx.get("amount") is not None else 50), str(fx.get("color") or "#00b140"), backdrop, progress)
        tmp.replace(out)
    w, h, _ = _probe(out)
    dur = end - start
    return {"src": f"media/fx/{out.name}", "in": 0, "out": round(dur, 3), "source_duration": round(dur, 3), "dim": [w, h],
            "bgfx": {**{k: fx[k] for k in ("amount", "color", "image") if fx.get(k) is not None}, "mode": mode, "status": "done", "orig": orig}}
