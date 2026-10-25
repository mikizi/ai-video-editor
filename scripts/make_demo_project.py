"""Create a self-contained demo montage project (synthetic media, no personal files).

    python scripts/make_demo_project.py            # -> projects/demo-montage
    python -m backlot serve --port 4750            # then open http://127.0.0.1:4750/e/demo-montage

Used for the README screenshots and as a quick way to try the editor without
importing any of your own photos.
"""

from __future__ import annotations

import json
import math
import struct
import sys
import wave
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT / "projects" / "demo-montage"
W, H = 1080, 1920

# (sky top, sky bottom, sun, ground, label)
SCENES = [
    ((255, 140, 90), (255, 214, 140), (255, 244, 200), (40, 30, 60), "sunrise"),
    ((40, 90, 170), (150, 210, 255), (255, 255, 235), (30, 110, 90), "meadow"),
    ((20, 20, 60), (90, 50, 130), (240, 230, 255), (10, 10, 25), "night"),
    ((250, 120, 150), (255, 190, 120), (255, 240, 220), (60, 40, 70), "dusk"),
    ((30, 140, 160), (170, 235, 225), (255, 255, 255), (20, 70, 90), "lagoon"),
    ((90, 60, 150), (240, 150, 140), (255, 225, 190), (30, 20, 50), "peaks"),
]


def _lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make_image(path: Path, idx: int) -> None:
    top, bottom, sun, ground, _ = SCENES[idx % len(SCENES)]
    img = Image.new("RGB", (W, H))
    px = ImageDraw.Draw(img)
    horizon = int(H * 0.62)
    for y in range(horizon):
        px.line([(0, y), (W, y)], fill=_lerp(top, bottom, y / horizon))
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    cx, cy = int(W * (0.3 + 0.1 * (idx % 5))), int(H * 0.42)
    ImageDraw.Draw(glow).ellipse([cx - 220, cy - 220, cx + 220, cy + 220], fill=sun)
    glow = glow.filter(ImageFilter.GaussianBlur(90))
    img = Image.blend(img, Image.composite(glow, img, glow.convert("L")), 0.65)
    px = ImageDraw.Draw(img)
    px.ellipse([cx - 70, cy - 70, cx + 70, cy + 70], fill=sun)
    for layer, shade in enumerate((0.55, 0.8, 1.0)):
        col = tuple(int(c * shade) for c in ground)
        base = horizon + layer * 70
        pts = [(0, H)]
        for x in range(0, W + 60, 60):
            pts.append((x, base - 90 * math.sin(x / 180 + idx * 1.7 + layer * 2) - 40 * layer))
        pts.append((W, H))
        px.polygon(pts, fill=col)
    img.save(path, quality=92)


def make_music(path: Path, seconds: float = 24.0, sr: int = 22050) -> None:
    notes = [220.0, 261.63, 329.63, 392.0]
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = bytearray()
        for i in range(int(seconds * sr)):
            t = i / sr
            f = notes[int(t / 0.5) % len(notes)]
            env = max(0.0, 1.0 - (t % 0.5) * 2.0)
            frames += struct.pack("<h", int(9000 * env * math.sin(2 * math.pi * f * t)))
        w.writeframes(bytes(frames))


def main() -> int:
    media = PROJECT / "public" / "media"
    music = PROJECT / "public" / "music"
    art = PROJECT / "artifacts"
    for d in (media, music, art):
        d.mkdir(parents=True, exist_ok=True)

    clips = []
    motions = ["zoom-in", "zoom-out", "pan-left", "pan-right", "zoom-in", "zoom-out"]
    transitions = ["flash", "whip", "fade", "slide-left", "iris", "glitch"]
    for i, (_, _, _, _, label) in enumerate(SCENES):
        name = f"{i + 1:02d}-{label}.jpg"
        make_image(media / name, i)
        clips.append({
            "id": f"c{i + 1:02d}", "src": f"media/{name}", "kind": "image", "label": label,
            "hold": 3.0, "fit": "cover", "motion": motions[i],
            "transition": {"type": transitions[i], "seconds": 0.35},
        })
    make_music(music / "demo-loop.wav")

    timeline = {
        "version": "1.0",
        "title": "Demo montage",
        "format": {"width": W, "height": H, "fps": 30},
        "style": {"font": "Heebo", "accent": "#FFD400", "grade": "warm", "vignette": True,
                  "beat_pulse": 0, "background": "#000000"},
        "clips": clips,
        "texts": [
            {"id": "t1", "value": "Demo montage", "start": 0.4, "end": 2.6, "position": "center", "style": "title"},
            {"id": "t2", "value": "Six places, one story", "start": 6.0, "end": 8.5, "position": "bottom", "style": "pop"},
        ],
        "music": {"src": "music/demo-loop.wav", "offset": 0, "volume": 0.8, "duck_volume": 0.25,
                  "fade_in": 0.5, "fade_out": 2, "start_at": "clips"},
    }
    (art / "timeline.json").write_text(json.dumps(timeline, indent=2))
    pj = PROJECT / "project.json"
    if not pj.exists():
        pj.write_text(json.dumps({"id": "demo-montage", "title": "Demo montage", "pipeline": "montage"}, indent=2))

    try:
        sys.path.insert(0, str(ROOT))
        from lib import timeline as tl
        tl.validate(timeline)
    except Exception as exc:  # validation is a courtesy check
        print(f"warning: timeline did not validate: {exc}")
    print(f"demo project ready: {PROJECT}")
    print("open: python -m backlot serve --port 4750  ->  http://127.0.0.1:4750/e/demo-montage")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
