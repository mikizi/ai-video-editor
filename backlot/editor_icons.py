"""Icons for the timeline: simple vector shapes (any colour) and emoji, made as transparent PNGs in public/media/icons.

The AI chat asks for one as a layer: {"id":"l_ai1","lane":2,"icon":"arrow-down","color":"#F4EFE6","start":1,"end":3,"scale":0.2,"x":0,"y":-0.3}
expand_layer() turns that into a normal layer (src = the PNG, kind = image, transform = scale/x/y).
"""
from __future__ import annotations

import hashlib
import math
from pathlib import Path
from typing import Any

SIZE = 512
EMOJI_FONT = "/System/Library/Fonts/Apple Color Emoji.ttc"
SHAPES = ["arrow-up", "arrow-down", "arrow-left", "arrow-right", "check", "cross", "plus", "minus", "star", "heart", "circle", "ring", "play", "drop", "bolt", "exclaim"]


def _poly_star(cx: float, cy: float, r: float, n: int = 5) -> list[tuple[float, float]]:
    pts = []
    for i in range(n * 2):
        a = -math.pi / 2 + i * math.pi / n
        rr = r if i % 2 == 0 else r * 0.42
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    return pts


def _draw_shape(name: str, color: str):
    from PIL import Image, ImageDraw
    k = 4                                     # draw large, shrink: smooth edges
    S = SIZE * k
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c, m = color, S * 0.12
    w = S * 0.14
    cx = cy = S / 2
    if name.startswith("arrow-"):
        dx, dy = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}[name[6:]]
        tip = (cx + dx * S * 0.38, cy + dy * S * 0.38)
        tail = (cx - dx * S * 0.38, cy - dy * S * 0.38)
        d.line([tail, (cx + dx * S * 0.1, cy + dy * S * 0.1)], fill=c, width=int(w))
        px, py = -dy, dx
        head = S * 0.26
        d.polygon([tip, (cx + dx * S * 0.02 + px * head, cy + dy * S * 0.02 + py * head), (cx + dx * S * 0.02 - px * head, cy + dy * S * 0.02 - py * head)], fill=c)
    elif name == "check":
        d.line([(S * 0.18, S * 0.54), (S * 0.42, S * 0.76), (S * 0.84, S * 0.26)], fill=c, width=int(w * 1.2), joint="curve")
        for p in [(S * 0.18, S * 0.54), (S * 0.42, S * 0.76), (S * 0.84, S * 0.26)]:
            d.ellipse([p[0] - w * 0.6, p[1] - w * 0.6, p[0] + w * 0.6, p[1] + w * 0.6], fill=c)
    elif name == "cross":
        d.line([(m * 1.4, m * 1.4), (S - m * 1.4, S - m * 1.4)], fill=c, width=int(w))
        d.line([(S - m * 1.4, m * 1.4), (m * 1.4, S - m * 1.4)], fill=c, width=int(w))
    elif name == "plus":
        d.line([(cx, m), (cx, S - m)], fill=c, width=int(w)); d.line([(m, cy), (S - m, cy)], fill=c, width=int(w))
    elif name == "minus":
        d.line([(m, cy), (S - m, cy)], fill=c, width=int(w))
    elif name == "star":
        d.polygon(_poly_star(cx, cy * 1.06, S * 0.46), fill=c)
    elif name == "heart":
        r = S * 0.24
        d.ellipse([cx - 2 * r + r * 0.15, S * 0.16, cx + r * 0.15, S * 0.16 + 2 * r], fill=c)
        d.ellipse([cx - r * 0.15, S * 0.16, cx + 2 * r - r * 0.15, S * 0.16 + 2 * r], fill=c)
        d.polygon([(cx - 2 * r + r * 0.25, S * 0.16 + r * 1.15), (cx + 2 * r - r * 0.25, S * 0.16 + r * 1.15), (cx, S * 0.88)], fill=c)
    elif name == "circle":
        d.ellipse([m, m, S - m, S - m], fill=c)
    elif name == "ring":
        d.ellipse([m, m, S - m, S - m], outline=c, width=int(w))
    elif name == "play":
        d.polygon([(S * 0.28, S * 0.16), (S * 0.28, S * 0.84), (S * 0.86, cy)], fill=c)
    elif name == "drop":
        d.polygon([(cx, S * 0.08), (S * 0.22, S * 0.58), (S * 0.78, S * 0.58)], fill=c)
        d.ellipse([S * 0.22, S * 0.4, S * 0.78, S * 0.92], fill=c)
    elif name == "bolt":
        d.polygon([(S * 0.58, S * 0.06), (S * 0.22, S * 0.54), (S * 0.46, S * 0.54), (S * 0.38, S * 0.94), (S * 0.78, S * 0.4), (S * 0.54, S * 0.4)], fill=c)
    elif name == "exclaim":
        d.rounded_rectangle([cx - w * 0.7, S * 0.08, cx + w * 0.7, S * 0.6], radius=int(w * 0.6), fill=c)
        d.ellipse([cx - w * 0.8, S * 0.72, cx + w * 0.8, S * 0.72 + w * 1.6], fill=c)
    else:
        raise ValueError(f"unknown icon {name!r}. Shapes: {', '.join(SHAPES)}, or one emoji")
    return img.resize((SIZE, SIZE), Image.LANCZOS)


def _draw_emoji(ch: str):
    from PIL import Image, ImageDraw, ImageFont
    if not Path(EMOJI_FONT).is_file():
        raise ValueError("emoji icons need the macOS emoji font; use one of the shapes instead")
    font = ImageFont.truetype(EMOJI_FONT, 160)
    img = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    ImageDraw.Draw(img).text((20, 14), ch, font=font, embedded_color=True)
    box = img.getbbox()
    if box:
        img = img.crop(box)
    side = max(img.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    return sq.resize((SIZE, SIZE), Image.LANCZOS)


def make_icon(project_dir: Path, name: str, color: str = "#F4EFE6") -> str:
    """Make (or reuse) the PNG for an icon; returns its path relative to public/."""
    name = str(name).strip()
    is_shape = name.lower() in SHAPES
    if not is_shape and (not name or name.isascii()):
        raise ValueError(f"unknown icon {name!r}. Shapes: {', '.join(SHAPES)}, or one emoji")
    key = hashlib.sha1(f"{name}|{color if is_shape else ''}".encode()).hexdigest()[:10]
    out = project_dir / "public" / "media" / "icons" / f"{(name.lower() if is_shape else 'emoji')}-{key}.png"
    if not out.is_file():
        out.parent.mkdir(parents=True, exist_ok=True)
        (_draw_shape(name.lower(), color) if is_shape else _draw_emoji(name)).save(out)
    return out.relative_to(project_dir / "public").as_posix()


def expand_layer(project_dir: Path, value: dict[str, Any]) -> dict[str, Any]:
    """{"icon","color","scale","x","y", ...} -> a normal image layer on lane 2 or 3."""
    src = make_icon(project_dir, value["icon"], value.get("color") or "#F4EFE6")
    layer = {k: v for k, v in value.items() if k not in ("icon", "color", "scale", "x", "y")}
    layer.update({"src": src, "kind": "image", "fit": "contain", "dim": [SIZE, SIZE], "label": f"icon {value['icon']}",
                  "transform": {"scale": float(value.get("scale", 0.2)), "x": float(value.get("x", 0)), "y": float(value.get("y", 0))}})
    layer.setdefault("lane", 2)
    return layer
