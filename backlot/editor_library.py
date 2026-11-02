"""The Cuts Bank as a searchable library: loose, typo-tolerant search over what people say in each cut.

The list lives in ``public/media/cuts-bank/bank.json`` (made by the cuts-bank builder). Used by the Media panel's search
box and by the AI chat, which can bring a cut into the timeline by its id.
"""

from __future__ import annotations

import json
import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

_STOP = {"the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "is", "it", "i", "me", "my", "we", "you", "that", "this",
         "say", "says", "said", "saying", "clip", "clips", "cut", "cuts", "video", "videos", "find", "get", "add", "put", "show",
         "with", "for", "about", "from", "talks", "talking", "something", "anything", "folder"}


def load_bank(project_dir: Path) -> list[dict[str, Any]]:
    p = project_dir / "public" / "media" / "cuts-bank" / "bank.json"
    try:
        cuts = json.loads(p.read_text(encoding="utf-8")).get("cuts") or []
    except (OSError, ValueError):
        return []
    return [c for c in cuts if isinstance(c, dict) and c.get("id") and c.get("rel")]


def _words(s: str) -> list[str]:
    return re.findall(r"[a-z0-9֐-׿]+", (s or "").lower())


def _sim(q: str, w: str) -> float:
    if q == w:
        return 1.0
    if len(q) >= 3 and (w.startswith(q) or q.startswith(w) and len(w) >= 3):
        return 0.9
    r = SequenceMatcher(None, q, w).ratio()
    return r if r >= 0.7 else 0.0


def score(query: str, cut: dict[str, Any]) -> float:
    qs = [w for w in _words(query) if w not in _STOP] or _words(query)
    if not qs:
        return 0.0
    doc = _words(" ".join(str(cut.get(k, "")) for k in ("text", "who", "name", "label", "cat", "sub")))
    if not doc:
        return 0.0
    per = [max((_sim(q, w) for w in doc), default=0.0) for q in qs]
    s = sum(per) / len(per)
    if len(qs) > 1 and " ".join(qs) in " ".join(doc):
        s += 0.15
    return min(s, 1.0)


def search(project_dir: Path, query: str, cat: str = "", limit: int = 30, floor: float = 0.45) -> list[dict[str, Any]]:
    out = []
    for c in load_bank(project_dir):
        if cat and cat != "All" and c.get("cat") != cat:
            continue
        s = score(query, c)
        if s >= floor:
            out.append({**c, "score": round(s, 2)})
    out.sort(key=lambda c: (-c["score"], c.get("len", 0)))
    return out[:limit]


def catalog_text(project_dir: Path) -> str:
    """Compact list for the AI prompt."""
    cuts = load_bank(project_dir)
    if not cuts:
        return ""
    cats = sorted({c.get("cat", "") for c in cuts})
    rows = [f'{c["id"]} | {c.get("cat", "")} | {c.get("who", "")} | {c.get("len", 0):.1f}s | "{(c.get("text") or "")[:140]}"' for c in cuts]
    return ("\nCUTS BANK (ready-made cuts of what people say; use one with {\"bank\":\"<id>\"}). Folders: " + "; ".join(cats)
            + "\nid | folder | who | length | what is said\n" + "\n".join(rows))


def expand_clip(project_dir: Path, value: dict[str, Any]) -> dict[str, Any]:
    """{"id","bank":"c012"} -> a full timeline clip pointing into the original video. Optional in/out widen or narrow the window."""
    c = next((x for x in load_bank(project_dir) if x["id"] == value.get("bank")), None)
    if not c:
        raise ValueError(f"unknown cut {value.get('bank')!r} in the Cuts Bank")
    a = float(value.get("in", c["in"])); b = float(value.get("out", c["out"]))
    dur = float(c.get("duration") or b)
    a, b = max(0.0, a), min(dur, b)
    clip = {"id": value["id"], "src": c["rel"], "kind": "video", "label": c.get("name") or c["id"], "in": round(a, 3), "out": round(b, 3),
            "source_duration": round(dur, 3), "speed": 1, "volume": 1, "fit": "cover", "motion": "none", "transition": {"type": "cut", "seconds": 0.1}}
    if c.get("width") and c.get("height"):
        clip["dim"] = [c["width"], c["height"]]
    return clip
