"""Editor extras: saved versions of the timeline and an AI chat that proposes edits.

Versions: every snapshot is a file in ``projects/<id>/artifacts/versions/`` so you can always go back.

Chat: the editor sends a request plus the selected clips. The server asks the local ``claude`` CLI (your Claude
subscription, no API key) for a list of small edit operations, applies them to a COPY of the timeline and returns the
copy as a proposal. Nothing is written to timeline.json here: the browser shows the proposal live, and only an
explicit Approve saves it (after taking a version snapshot).
"""

from __future__ import annotations

import asyncio
import copy
import json
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import jsonschema
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backlot import editor_icons, editor_inspo, editor_library
from lib import timeline as T
from lib.paths import REPO_ROOT

CHAT_MODEL = os.environ.get("BACKLOT_CHAT_MODEL", "sonnet")
CHAT_TIMEOUT = 300

_chat_jobs: dict[str, dict[str, Any]] = {}
_chat_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Versions
# ---------------------------------------------------------------------------

def _versions_dir(project_dir: Path) -> Path:
    return project_dir / "artifacts" / "versions"


def _next_n(vdir: Path) -> int:
    ns = [int(m.group(1)) for p in vdir.glob("v*.json") if (m := re.match(r"v(\d+)", p.name))] if vdir.is_dir() else []
    return max(ns, default=0) + 1


def snapshot(project_dir: Path, tl: dict[str, Any], label: str, source: str = "manual") -> dict[str, Any]:
    """Write one version file and return its metadata."""
    vdir = _versions_dir(project_dir)
    vdir.mkdir(parents=True, exist_ok=True)
    n = _next_n(vdir)
    vid = f"v{n:04d}"
    meta = {
        "id": vid, "n": n, "label": (label or "").strip()[:120] or "Saved version", "source": source,
        "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "clips": len(tl.get("clips", [])), "texts": len(tl.get("texts", [])),
    }
    tmp = vdir / f".{vid}.tmp"
    tmp.write_text(json.dumps({**meta, "timeline": tl}, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, vdir / f"{vid}.json")
    return meta


def list_versions(project_dir: Path) -> list[dict[str, Any]]:
    vdir = _versions_dir(project_dir)
    out = []
    for p in sorted(vdir.glob("v*.json")) if vdir.is_dir() else []:
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        out.append({k: d.get(k) for k in ("id", "n", "label", "source", "created", "clips", "texts")})
    return list(reversed(out))   # newest first


def read_version(project_dir: Path, vid: str) -> dict[str, Any]:
    if not re.fullmatch(r"v\d+", vid):
        raise HTTPException(status_code=400, detail="invalid version id")
    p = _versions_dir(project_dir) / f"{vid}.json"
    if not p.is_file():
        raise HTTPException(status_code=404, detail="unknown version")
    return json.loads(p.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Edit operations (what Claude returns)
# ---------------------------------------------------------------------------

class OpError(ValueError):
    pass


def _child(node: Any, seg: str) -> Any:
    """Step into a dict key, or into a list element by its `id` (then by index)."""
    if isinstance(node, dict):
        if seg not in node:
            raise KeyError(seg)
        return node[seg]
    if isinstance(node, list):
        for el in node:
            if isinstance(el, dict) and el.get("id") == seg:
                return el
        if seg.lstrip("-").isdigit() and -len(node) <= int(seg) < len(node):
            return node[int(seg)]
    raise KeyError(seg)


def _resolve(root: dict, path: str, create: bool = False) -> tuple[Any, str]:
    """Return (parent, last_segment) for a path like ``clips/c03/adjust/contrast``."""
    segs = [s for s in path.strip("/").split("/") if s != ""]
    if not segs:
        raise OpError("empty path")
    node = root
    for seg in segs[:-1]:
        try:
            node = _child(node, seg)
        except KeyError:
            if create and isinstance(node, dict):
                node[seg] = {}
                node = node[seg]
            else:
                raise OpError(f"path not found: {path} (at '{seg}')")
    return node, segs[-1]


def _get(root: dict, path: str) -> Any:
    parent, last = _resolve(root, path)
    try:
        return _child(parent, last)
    except KeyError:
        return None


def apply_ops(tl: dict[str, Any], ops: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Apply ops to a deep copy. Returns (new timeline, change list for the UI)."""
    out = copy.deepcopy(tl)
    changes: list[dict[str, Any]] = []
    for op in ops:
        kind, path = op.get("op"), str(op.get("path", ""))
        if kind == "set":
            before = _get(out, path) if _safe_exists(out, path) else None
            parent, last = _resolve(out, path, create=True)
            val = copy.deepcopy(op.get("value"))
            if isinstance(parent, dict):
                parent[last] = val
            elif isinstance(parent, list):
                el = _child(parent, last)
                idx = parent.index(el)
                parent[idx] = val
            else:
                raise OpError(f"cannot set {path}")
            changes.append({"op": "set", "path": path, "before": before, "after": val})
        elif kind == "remove":
            before = _get(out, path)
            parent, last = _resolve(out, path)
            if isinstance(parent, dict):
                parent.pop(last, None)
            elif isinstance(parent, list):
                parent.remove(_child(parent, last))
            changes.append({"op": "remove", "path": path, "before": before})
        elif kind == "add":
            target = _get(out, path) if _safe_exists(out, path) else None
            if target is None and "/" not in path.strip("/"):
                out[path.strip("/")] = target = []
            if not isinstance(target, list):
                raise OpError(f"cannot add to {path}: not a list")
            val = copy.deepcopy(op.get("value"))
            idx = op.get("index")
            target.insert(idx if isinstance(idx, int) else len(target), val)
            changes.append({"op": "add", "path": path, "after": val})
        elif kind == "move":
            parent, last = _resolve(out, path)
            if not isinstance(parent, list):
                raise OpError(f"cannot move {path}: not a list item")
            el = _child(parent, last)
            parent.remove(el)
            to = op.get("to")
            parent.insert(max(0, min(len(parent), to if isinstance(to, int) else len(parent))), el)
            changes.append({"op": "move", "path": path, "to": to})
        else:
            raise OpError(f"unknown op: {kind}")
    return out, changes


def _safe_exists(root: dict, path: str) -> bool:
    try:
        parent, last = _resolve(root, path)
        _child(parent, last)
        return True
    except (OpError, KeyError):
        return False


def _short(v: Any) -> str:
    s = json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v
    return s if len(s) <= 60 else s[:57] + "..."


def describe(changes: list[dict[str, Any]]) -> list[str]:
    lines = []
    for c in changes:
        p = c["path"]
        if c["op"] == "set":
            lines.append(f"{p}: {_short(c.get('before'))} -> {_short(c['after'])}" if c.get("before") is not None else f"{p} = {_short(c['after'])}")
        elif c["op"] == "remove":
            lines.append(f"remove {p}")
        elif c["op"] == "add":
            v = c["after"]
            lines.append(f"add to {p}: {_short(v.get('id') or v.get('value') or v) if isinstance(v, dict) else _short(v)}")
        elif c["op"] == "move":
            lines.append(f"move {p} to position {c.get('to')}")
    return lines


def changed_clip_ids(tl: dict[str, Any], changes: list[dict[str, Any]]) -> list[str]:
    ids = []
    known = {c["id"] for c in tl.get("clips", [])}
    for c in changes:
        segs = c["path"].strip("/").split("/")
        if len(segs) >= 2 and segs[0] == "clips" and segs[1] in known and segs[1] not in ids:
            ids.append(segs[1])
    return ids


# ---------------------------------------------------------------------------
# Talking to Claude
# ---------------------------------------------------------------------------

SYSTEM = """You are the editing assistant inside a video timeline editor. The user looks at the video preview and asks for changes.
You answer ONLY with one JSON object (no markdown, no text around it):
{"reply": "<one or two short plain sentences saying what you changed or why you could not>", "ops": [ ... ]}

ops is a list of small edit operations applied in order to the timeline JSON. Paths use "/" and reach into arrays by the item's "id":
  {"op":"set","path":"clips/c03/adjust/contrast","value":1.3}      set (or create) a value; missing objects on the way are created
  {"op":"remove","path":"clips/c03/adjust"}                         delete a key or an array item
  {"op":"add","path":"texts","value":{...},"index":2}               insert into an array (index optional = append)
  {"op":"move","path":"clips/c03","to":0}                           reorder an array item to a position

Rules:
- Change as little as possible. Touch only what the user asked for. If clips are selected, change ONLY those clips unless the request clearly says otherwise.
- Never invent media files. Only use "src" values that appear in the timeline or in the media list you are given.
- New items need a unique "id" (for example "t_ai1", "c_ai1").
- Clip picture tweaks go in clips/<id>/adjust: {"contrast":1.25,"brightness":1.05,"saturation":1.1} (1 = unchanged, range 0 to 3). Global look: style/grade (none, warm, cool, vivid, film, bw).
- Picture position (the video is independent of its frame, like CapCut): clips/<id>/transform {"x":0,"y":0,"scale":1,"rotate":0}. x and y are fractions of the frame (0 = centred, y -0.25 = up a quarter), scale 1 fills the frame, 0.5 = half size (leaves open space), rotate in degrees. clips/<id>/bg is the colour of the open space. Do not move a picture off screen unless asked.
- Crop (cut the edges of the picture): clips/<id>/crop {"l":0.1,"t":0,"r":0.1,"b":0} as fractions (0 to 0.95) of the picture removed from each side. Layers have "crop" and "transform" too.
- Video inside video (picture-in-picture): a "layers" item with "transform", for example {"scale":0.38,"x":0.28,"y":0.28} = small video in the bottom right corner, plus "rounded":true.
- Extra video channels: the top-level "layers" array, each {"id","lane":2|3,"src","kind":"video"|"image","start","end"} (seconds on the montage clock), optional in, speed, volume, fit, x, y, width, opacity, adjust. Lane 3 draws above lane 2, both above the main video.
- Music channels: music and music_more items have "lane" 1, 2 or 3.
- Texts: texts array items {"id","value","start","end","position":"top|center|bottom","style":"pop|subtitle|title|cine"}, times in seconds on the montage clock.
- Volume line (sound over time) on clips, layers and music: vol [{"t":seconds from the start of that clip or song,"db":decibels relative to its volume, 0 = unchanged, -40 = silent}], straight lines between points. Example fade-out: [{"t":0,"db":0},{"t":3,"db":-40}]. volume itself is linear 0 to 1 (0.5 = -6 dB).
- Clip fields: in/out (seconds in the source), speed, volume, fit, motion, transition {type, seconds}, text, zoom, rotate, hold (images).
- Background of the person in a clip (blur it or replace it): set clips/<id>/bgfx to {"mode":"blur","amount":10,"status":"todo"} (amount = blur strength 0 to 100 percent; "10% blur" means amount 10). Replace the background with a colour: {"mode":"color","color":"#00b140","status":"todo"}; with a photo or video from the media list: {"mode":"image","image":"<src from the media list>","status":"todo"}; remove the effect: {"mode":"none","status":"todo"}. Always include "status":"todo". Only for video clips; if clips are selected use those. The editor makes the new video after the user approves, so say it will take about as long as the clip.
- ATTACHED FILES: a line "[Attached by the user, already in the media bin: ...]" at the end of the request lists photos or videos the user just added. "This photo" or "this video" means those files; use their exact path as the "src" or "image" value.
- ICONS AND GRAPHICS: you CAN add an icon. Add a layer with an "icon" instead of a "src": {"op":"add","path":"layers","value":{"id":"l_ai1","lane":2,"icon":"arrow-down","color":"#F4EFE6","start":1.0,"end":3.0,"scale":0.2,"x":0,"y":-0.25}}. "icon" is one of: arrow-up, arrow-down, arrow-left, arrow-right, check, cross, plus, minus, star, heart, circle, ring, play, drop, bolt, exclaim (these take "color" as a hex colour), or a single emoji such as "🔥" or "🌱" (emoji keep their own colours). "scale" is the icon width as a fraction of the frame width (0.2 = a fifth), x and y move it from the centre as fractions of the frame (y negative = up). start/end are seconds on the montage clock; add "fade" or other layer fields only if the schema has them. Never refuse an icon, an arrow, a check mark or an emoji. POP-UP ANIMATION: add "pop": 0.6 to any layer (icons especially) and it grows from zero with a bounce when it appears; the number is how many seconds the pop lasts. Use it for "pop up", "bounce in", "social media style". Do not say keyframe scale animation is impossible.
- Be honest: if the request is impossible in this editor or unclear, return "ops": [] and say so in "reply" (ask one short question if needed).
- RULES: "THE USER'S RULES" are the user's approved style rules, learned from their inspiration board. Follow them by default, unless the request clearly says otherwise, and name the rule you used in "reply".
- Pixels: the frame size is timeline "format" (width x height in pixels). A rule or request may give positions or sizes in pixels, measured like the editor's rulers: origin at the BOTTOM LEFT, x to the right, y UP from the bottom edge. Convert them: transform.x = (picture centre x - width/2) / width; transform.y = (height/2 - picture centre y) / height (transform.y is positive DOWN); scale is the new width divided by the picture's width in the frame; crop is pixels removed divided by the picture size.
- INSPIRATION BOARD: the request can come with the user's own references (written rules, screenshots, reference videos). The written notes are standing preferences: follow them by default (placement, subtitle style, pacing). When picture files are listed, open each one with the Read tool before answering, look at where things sit (subtitles, titles, how the picture is framed or cropped, picture-in-picture) and reproduce that look with the fields above. Say in "reply" what you took from the board. Do not invent text styles that do not exist: texts use style pop, subtitle, title or cine and position top, center or bottom.
- CUTS BANK: when the request is about what a person says (even misspelled, half remembered or loosely worded), find the closest cut in the CUTS BANK list by meaning and add it to the timeline: {"op":"add","path":"clips","value":{"id":"c_ai1","bank":"<cut id>"},"index":N}. The server fills in the rest. Optional "in"/"out" (seconds in the original video) widen or narrow the cut. Put it right after the selected clip, or at the end if none is selected. "From a folder" means take cuts whose folder matches. Several cuts are fine when asked.
- If the best cut is only a loose fit, still add the closest one, and in "reply" quote what it says so the user can judge, and say plainly that it is only the closest match. If nothing is even loosely close, add nothing and say what the bank does have.
- Do not use long dashes in "reply".

Timeline format (TypeScript types):
"""


def _types_text() -> str:
    try:
        return (REPO_ROOT / "remotion-composer" / "src" / "montage" / "types.ts").read_text(encoding="utf-8")
    except OSError:
        return ""


def _clean_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not (k.startswith("CLAUDE_CODE") or k in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"))}
    env.pop("ANTHROPIC_API_KEY", None)   # use the logged-in subscription, never a stray API key
    return env


def _extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    a, b = text.find("{"), text.rfind("}")
    if a < 0 or b <= a:
        raise OpError("Claude did not return an edit")
    try:
        return json.loads(text[a:b + 1])
    except ValueError as exc:
        raise OpError(f"Claude returned invalid JSON: {exc}")


def _ask_claude(prompt: str, look_in: Optional[str] = None, system: Optional[str] = None, timeout: int = CHAT_TIMEOUT) -> str:
    # No tools at all, except: when board pictures are given, the Read tool, limited to the board folder.
    tools = ["--tools", "Read", "--allowedTools", "Read", "--add-dir", look_in] if look_in else ["--tools", ""]
    with tempfile.TemporaryDirectory(prefix="backlot-chat-") as cwd:   # outside any repo: no CLAUDE.md gets loaded
        res = subprocess.run(
            ["claude", "-p", "--model", CHAT_MODEL, *tools, "--no-session-persistence", "--disable-slash-commands",
             "--strict-mcp-config", "--output-format", "json", "--system-prompt", system or (SYSTEM + _types_text())],
            input=prompt, capture_output=True, text=True, timeout=timeout, cwd=cwd, env=_clean_env(),
        )
    if res.returncode != 0:
        raise OpError((res.stderr or res.stdout or "claude failed").strip()[-400:])
    try:
        data = json.loads(res.stdout)
    except ValueError:
        return res.stdout
    if data.get("is_error"):
        raise OpError(str(data.get("result") or "claude failed")[:400])
    return str(data.get("result") or "")


def _rules_text(rules: list[dict[str, Any]]) -> str:
    if not rules:
        return ""
    return "\nTHE USER'S RULES (approved, learned from their inspiration board):\n" + "\n".join(
        f"- [{r.get('category', 'other')}] {r.get('title', '')}: {r.get('text', '')}" for r in rules)


def _board_text(board: dict[str, Any], with_pictures: bool) -> str:
    if not board["items"]:
        return ""
    lines = ["\nINSPIRATION BOARD (the user's own references and rules for how they like their videos):"]
    hidden = 0
    for it in board["items"]:
        row = f'- "{it["title"]}" ({it["kind"]})' + (f": {it['note']}" if it["note"] else "")
        if it["files"]:
            row += "  PICTURES TO OPEN WITH THE READ TOOL: " + ", ".join(it["files"])
        elif it["kind"] in ("image", "video") and not with_pictures:
            hidden += 1
        lines.append(row)
    if hidden:
        lines.append(f"({hidden} picture/video references are on the board but are not shown this time.)")
    return "\n".join(lines)


def _build_prompt(tl: dict[str, Any], message: str, clip_ids: list[str], media: list[str], history: list[dict[str, str]], board_txt: str = "", bank_txt: str = "") -> str:
    slim = {k: v for k, v in tl.items() if k not in ("comments", "metadata")}
    parts = [
        "CURRENT TIMELINE JSON:", json.dumps(slim, ensure_ascii=False),
        "\nMEDIA FILES IN THE PROJECT:", json.dumps(media, ensure_ascii=False),
        "\nSELECTED CLIPS: " + (", ".join(clip_ids) if clip_ids else "(none selected: the request is about the whole video)"),
    ]
    if history:
        parts.append("\nEARLIER IN THIS CHAT (oldest first):")
        parts += [f"{h['role']}: {h['text']}" for h in history[-6:]]
    if board_txt:
        parts.append(board_txt)
    if bank_txt:
        parts.append(bank_txt)
    parts.append("\nUSER REQUEST: " + message)
    return "\n".join(parts)


def _bank_text(project_dir: Path, message: str) -> str:
    txt = editor_library.catalog_text(project_dir)
    if not txt:
        return ""
    best = editor_library.search(project_dir, message, limit=6, floor=0.5)
    if best:
        txt += "\nCLOSEST BY SPELLING to the request (a hint, you may choose differently): " + ", ".join(f'{b["id"]} ({b["score"]})' for b in best)
    return txt


def run_chat(project_dir: Path, tl: dict[str, Any], message: str, clip_ids: list[str], history: list[dict[str, str]], use_board: bool = False) -> dict[str, Any]:
    media = sorted(str(p.relative_to(project_dir / "public")) for p in (project_dir / "public").rglob("*")
                   if p.is_file() and "_sources" not in p.parts and "cuts-bank" not in p.parts and p.suffix.lower() in (T.VIDEO_EXTS | T.IMAGE_EXTS | T.AUDIO_EXTS)) if (project_dir / "public").is_dir() else []
    board = editor_inspo.board_for_ai(project_dir, use_board)
    look_in = board["dir"] if any(it["files"] for it in board["items"]) else None
    prompt = _build_prompt(tl, message, clip_ids, media, history, _rules_text(editor_inspo.active_rules(project_dir)) + _board_text(board, use_board), _bank_text(project_dir, message))
    err: Optional[str] = None
    for attempt in range(2):
        text = _ask_claude(prompt if not err else prompt + f"\n\nYour previous answer was rejected: {err}\nReturn a corrected JSON object.", look_in)
        try:
            data = _extract_json(text)
            ops = data.get("ops") or []
            if not isinstance(ops, list):
                raise OpError("ops must be a list")
            if not ops:
                return {"reply": str(data.get("reply") or "No change."), "changes": [], "lines": [], "timeline": None, "clip_ids": []}
            for op in ops:   # a library cut is added as {"bank": id}; an icon as {"icon": name}; fill in the real clip / layer
                v = op.get("value")
                if op.get("op") == "add" and isinstance(v, dict) and v.get("icon") and str(op.get("path", "")).strip("/") == "layers":
                    try:
                        op["value"] = editor_icons.expand_layer(project_dir, v)
                    except (ValueError, OSError) as exc:
                        raise OpError(str(exc))
                    continue
                if op.get("op") == "add" and isinstance(v, dict) and v.get("bank"):
                    try:
                        op["value"] = editor_library.expand_clip(project_dir, v)
                    except ValueError as exc:
                        raise OpError(str(exc))
            proposal, changes = apply_ops(tl, ops)
            T.validate(proposal)
            return {"reply": str(data.get("reply") or "Here is the change."), "changes": changes, "lines": describe(changes),
                    "timeline": proposal, "clip_ids": changed_clip_ids(tl, changes)}
        except (OpError, jsonschema.ValidationError, T.TimelineError) as exc:
            err = str(getattr(exc, "message", exc))[:300]
    raise OpError(f"Claude's change did not fit the timeline: {err}")


# ---------------------------------------------------------------------------
# Voice notes: speech to text, locally (faster-whisper), so nothing is uploaded
# ---------------------------------------------------------------------------

STT_MODEL = os.environ.get("BACKLOT_STT_MODEL", "small")
_stt: dict[str, Any] = {"model": None}
_stt_lock = threading.Lock()


def _stt_model():
    if _stt["model"] is None:
        from faster_whisper import WhisperModel   # imported late: the editor works without it until the mic is used
        _stt["model"] = WhisperModel(STT_MODEL, device="cpu", compute_type="int8")
    return _stt["model"]


def transcribe_audio(data: bytes, language: Optional[str] = None) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="backlot-stt-") as td:
        src, wav = Path(td) / "in.bin", Path(td) / "in.wav"
        src.write_bytes(data)
        r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-ac", "1", "-ar", "16000", str(wav)],
                           capture_output=True, text=True, timeout=120)
        if r.returncode != 0 or not wav.exists():
            raise OpError("Could not read the recording")
        with _stt_lock:
            segs, info = _stt_model().transcribe(str(wav), language=language or None, vad_filter=True, beam_size=1)
            text = " ".join(sg.text.strip() for sg in segs).strip()
    return {"text": text, "language": info.language}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

class VersionBody(BaseModel):
    label: str = ""
    timeline: Optional[dict] = None
    source: str = "manual"


class ChatBody(BaseModel):
    message: str
    clip_ids: list[str] = []
    timeline: dict
    history: list[dict[str, str]] = []
    use_board: bool = False


def register(router: APIRouter, project_dir_of) -> None:
    @router.post("/stt/warm")
    async def stt_warm() -> dict:
        """Load the speech model in the background so the first recording is not slow."""
        def work() -> None:
            try:
                with _stt_lock:
                    _stt_model()
            except Exception:  # noqa: BLE001  (reported when the user actually transcribes)
                pass
        threading.Thread(target=work, daemon=True).start()
        return {"ok": True}

    @router.post("/transcribe")
    async def transcribe(request: Request, lang: str = "") -> dict:
        data = await request.body()
        if not data:
            raise HTTPException(status_code=422, detail="the recording is empty")
        if len(data) > 25 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="the recording is too long (limit about 10 minutes)")
        if lang not in ("", "he", "en"):
            raise HTTPException(status_code=422, detail="unsupported language")
        try:
            return await asyncio.to_thread(transcribe_audio, data, lang or None)
        except OpError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        except ImportError:
            raise HTTPException(status_code=501, detail="Speech to text is not installed (pip install faster-whisper in the project's venv)")

    @router.get("/{project_id}/library-search")
    async def library_search(project_id: str, q: str = "", cat: str = "") -> dict:
        d = project_dir_of(project_id)
        return {"cuts": editor_library.search(d, q, cat) if q.strip() else []}

    @router.get("/{project_id}/versions")
    async def versions_list(project_id: str) -> dict:
        return {"versions": list_versions(project_dir_of(project_id))}

    @router.post("/{project_id}/versions")
    async def versions_save(project_id: str, body: VersionBody) -> dict:
        d = project_dir_of(project_id)
        tl = body.timeline
        if tl is None:
            p = T.timeline_path(d)
            if not p.exists():
                raise HTTPException(status_code=404, detail="no timeline to save")
            tl = json.loads(p.read_text(encoding="utf-8"))
        return snapshot(d, tl, body.label, body.source if body.source in ("manual", "auto", "ai") else "manual")

    @router.get("/{project_id}/versions/{vid}")
    async def versions_get(project_id: str, vid: str) -> dict:
        return read_version(project_dir_of(project_id), vid)

    @router.post("/{project_id}/chat")
    async def chat_start(project_id: str, body: ChatBody) -> dict:
        d = project_dir_of(project_id)
        msg = body.message.strip()
        if not msg:
            raise HTTPException(status_code=422, detail="write a request first")
        with _chat_lock:
            job = _chat_jobs.get(project_id)
            if job and job.get("running"):
                raise HTTPException(status_code=409, detail="the assistant is still working on the last request")
            jid = uuid.uuid4().hex[:8]
            _chat_jobs[project_id] = {"id": jid, "running": True, "ok": None, "error": None, "result": None, "started_at": time.time()}

        def work() -> None:
            j = _chat_jobs[project_id]
            try:
                j["result"] = run_chat(d, body.timeline, msg, body.clip_ids, body.history, body.use_board)
                j["ok"] = True
            except subprocess.TimeoutExpired:
                j["ok"], j["error"] = False, "The assistant took too long. Try a smaller request."
            except FileNotFoundError:
                j["ok"], j["error"] = False, "The 'claude' command was not found on this computer."
            except Exception as exc:  # noqa: BLE001  (shown to the user, never crash the server thread)
                j["ok"], j["error"] = False, str(exc)
            finally:
                j["running"] = False

        threading.Thread(target=work, daemon=True).start()
        return {"id": jid, "running": True}

    @router.get("/{project_id}/chat")
    async def chat_status(project_id: str) -> dict:
        project_dir_of(project_id)
        return _chat_jobs.get(project_id) or {"running": False}
