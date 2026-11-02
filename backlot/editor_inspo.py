"""Inspiration board: references the AI chat can learn from.

Everything lives in ``projects/<id>/inspiration/`` (outside ``public/`` so renders never bundle it):
screenshots and reference videos you add, plus written notes ("subtitles sit in the lower third ...").
``board.json`` keeps the titles / notes. The chat always reads the written notes (standing preferences);
the pictures are only shown to the AI when you ask it to take inspiration from the board.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from lib import timeline as T

BOARD_DIR = "inspiration"
MAX_BYTES = 600 * 1024 * 1024
MAX_AI_IMAGES = 12          # most pictures the AI is shown per request
_lock = threading.Lock()


def _dir(pd: Path) -> Path:
    return pd / BOARD_DIR


def _load(pd: Path) -> list[dict[str, Any]]:
    p = _dir(pd) / "board.json"
    try:
        return json.loads(p.read_text(encoding="utf-8")).get("items", [])
    except (OSError, ValueError):
        return []


def _save(pd: Path, items: list[dict[str, Any]]) -> None:
    d = _dir(pd)
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / ".board.tmp"
    tmp.write_text(json.dumps({"items": items}, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, d / "board.json")


def _public(it: dict[str, Any]) -> dict[str, Any]:
    return {**it, "src": f"{BOARD_DIR}/{it['file']}" if it.get("file") else None}


def _kind_of(name: str) -> Optional[str]:
    s = Path(name).suffix.lower()
    return "image" if s in T.IMAGE_EXTS else "video" if s in T.VIDEO_EXTS else None


# ---------------------------------------------------------------------------
# Pictures for the AI: small JPEGs it can open with its Read tool
# ---------------------------------------------------------------------------

def _cache_dir(pd: Path) -> Path:
    d = _dir(pd) / ".cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _image_jpeg(src: Path, out: Path) -> bool:
    if out.exists():
        return True
    try:
        from PIL import Image
        with Image.open(src) as im:
            im = im.convert("RGB")
            im.thumbnail((1280, 1280))
            im.save(out, "JPEG", quality=82)
        return True
    except Exception:  # noqa: BLE001  (a broken picture is skipped, never fatal)
        return False


def _video_frames(src: Path, stem: str, cache: Path, n: int = 3) -> list[Path]:
    dur = T.probe_duration(src) or 0
    out: list[Path] = []
    for i in range(n):
        f = cache / f"{stem}-{i}.jpg"
        if not f.exists():
            t = dur * (i + 1) / (n + 1) if dur else 0
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.2f}", "-i", str(src), "-frames:v", "1",
                            "-vf", "scale='min(1024,iw)':-2", str(f)], capture_output=True, timeout=60)
        if f.exists():
            out.append(f)
    return out


def board_for_ai(pd: Path, with_pictures: bool) -> dict[str, Any]:
    """What the chat prompt gets: every note, and (optionally) picture files the AI can open."""
    items = [i for i in _load(pd) if i.get("use", True)]
    notes, pics, shown = [], [], 0
    cache = _cache_dir(pd) if items else None
    for it in reversed(items):                      # newest first, so a cap drops the oldest
        label = (it.get("title") or "").strip() or it.get("file") or "note"
        entry = {"title": label, "note": (it.get("note") or "").strip(), "kind": it["kind"], "files": []}
        if with_pictures and it.get("file") and shown < MAX_AI_IMAGES:
            src = _dir(pd) / it["file"]
            if src.is_file():
                files = ([cache / f"{it['id']}.jpg"] if it["kind"] == "image" and _image_jpeg(src, cache / f"{it['id']}.jpg")
                         else _video_frames(src, it["id"], cache) if it["kind"] == "video" else [])
                entry["files"] = [str(f) for f in files[: MAX_AI_IMAGES - shown]]
                shown += len(entry["files"])
        if entry["note"] or entry["files"] or it["kind"] != "note" or entry["title"]:
            notes.append(entry)
    return {"items": notes, "dir": str(_dir(pd).resolve()) if items else None, "total": len(_load(pd))}


# ---------------------------------------------------------------------------
# Rules: what the analysis learned from the board. Draft -> (you approve) -> active. Only active rules reach the chat.
# ---------------------------------------------------------------------------

CATEGORIES = ("subtitles", "text", "framing", "layout", "pacing", "transitions", "color", "audio", "other")


def _rules_load(pd: Path) -> list[dict[str, Any]]:
    try:
        return json.loads((_dir(pd) / "rules.json").read_text(encoding="utf-8")).get("rules", [])
    except (OSError, ValueError):
        return []


def _rules_save(pd: Path, rules: list[dict[str, Any]]) -> None:
    d = _dir(pd)
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / ".rules.tmp"
    tmp.write_text(json.dumps({"rules": rules}, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, d / "rules.json")


def active_rules(pd: Path) -> list[dict[str, Any]]:
    return [r for r in _rules_load(pd) if r.get("status") == "active"]


ANALYSE_SYSTEM = """You study reference pictures and videos that a video creator saved as inspiration, and turn what you see into short, concrete RULES that an editing assistant can follow later in a timeline editor.
Open every listed picture with the Read tool before answering. Answer ONLY with one JSON object, no markdown, no text around it:
{"summary": "<one short sentence about what these references have in common>", "rules": [{"category": "subtitles|text|framing|layout|pacing|transitions|color|audio|other", "title": "<3 to 6 words>", "text": "<one or two sentences, concrete and measurable>"}]}

Write rules in terms the editor can actually do:
- Text and subtitles: style pop, subtitle, title or cine; position top, center or bottom (say "lower third" = bottom); how many lines, how long on screen, colours and which word is highlighted.
- Picture framing: picture position as fractions of the frame (x across, y up or down, 0 = centred), size in percent, crop in percent from each side, tilt in degrees, the colour of the open space.
- Layout: picture-in-picture (a smaller video on top of another, which corner, what size, rounded corners), split screens.
- Pacing: clip length in seconds, cut rhythm, transitions (cut, fade, flash, zoom, whip, slide, glitch ...), motion (zoom-in, zoom-out, pan).
- Colour: grade (none, warm, cool, vivid, film, bw), contrast, brightness, saturation.
- Audio: music volume, fades.
Rules:
- Only write a rule you can see evidence for in the pictures or in the user's notes. Prefer numbers over adjectives.
- 3 to 8 rules. Do not repeat the existing rules you are given. Keep each rule independent.
- The user's notes on each reference say what they care about: weigh them most.
- Do not use long dashes."""


def _analyse_prompt(pd: Path, item_ids: Optional[list[str]]) -> tuple[str, Optional[str], list[str]]:
    items = [i for i in _load(pd) if i.get("use", True) and (not item_ids or i["id"] in item_ids)]
    if not items:
        raise ValueError("Add something to the board first (and keep \"Use\" ticked).")
    cache = _cache_dir(pd)
    lines, shown, titles = [], 0, []
    for it in items:
        label = (it.get("title") or "").strip() or it.get("file") or "note"
        titles.append(label)
        row = f'- "{label}" ({it["kind"]})' + (f': the user says: {it["note"].strip()}' if (it.get("note") or "").strip() else "")
        if it.get("file") and shown < MAX_AI_IMAGES:
            src = _dir(pd) / it["file"]
            if src.is_file():
                files = ([cache / f"{it['id']}.jpg"] if it["kind"] == "image" and _image_jpeg(src, cache / f"{it['id']}.jpg")
                         else _video_frames(src, it["id"], cache) if it["kind"] == "video" else [])
                files = files[: MAX_AI_IMAGES - shown]
                shown += len(files)
                if files:
                    row += ("  PICTURES TO OPEN WITH THE READ TOOL (frames from the video, early to late): " if it["kind"] == "video" else "  PICTURE TO OPEN WITH THE READ TOOL: ") + ", ".join(str(f) for f in files)
        lines.append(row)
    fmt = {}
    try:
        fmt = json.loads(T.timeline_path(pd).read_text(encoding="utf-8")).get("format", {})
    except (OSError, ValueError):
        pass
    fw, fh = fmt.get("width", 1080), fmt.get("height", 1920)
    prompt_head = (f"THE VIDEO FRAME IS {fw} x {fh} PIXELS. The references may be screenshots of other sizes: work in proportions, then give each position or size "
                   f"ALSO in pixels of this frame, measured like the editor's rulers: origin at the BOTTOM LEFT, x to the right, y counted UP from the bottom edge (for example: a subtitle block centred at y = {int(fh * 0.22)} px from the bottom, about {int(fw * 0.8)} px wide). Pixel numbers help the user check the rule against the real frame.\n\n")
    existing = active_rules(pd) + [r for r in _rules_load(pd) if r.get("status") == "draft"]
    prompt = prompt_head + "REFERENCES ON THE BOARD:\n" + "\n".join(lines)
    if existing:
        prompt += "\n\nEXISTING RULES (do not repeat these):\n" + "\n".join(f"- {r.get('title', '')}: {r.get('text', '')}" for r in existing)
    return prompt, (str(_dir(pd).resolve()) if shown else None), titles


def analyse(pd: Path, item_ids: Optional[list[str]]) -> dict[str, Any]:
    from backlot import editor_ai   # late import: editor_ai imports this module
    prompt, look_in, titles = _analyse_prompt(pd, item_ids)
    text = editor_ai._ask_claude(prompt, look_in, system=ANALYSE_SYSTEM, timeout=420)
    data = editor_ai._extract_json(text)
    out = []
    for r in data.get("rules") or []:
        t = str(r.get("text") or "").strip()
        if not t:
            continue
        cat = str(r.get("category") or "other").lower()
        out.append({"id": uuid.uuid4().hex[:8], "category": cat if cat in CATEGORIES else "other",
                    "title": str(r.get("title") or "Rule").strip()[:80], "text": t, "status": "draft",
                    "source": ", ".join(titles)[:160], "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    if not out:
        raise ValueError("The analysis found no clear rules. Add a note to a reference saying what you like about it, and try again.")
    with _lock:
        rules = _rules_load(pd)
        rules.extend(out)
        _rules_save(pd, rules)
    return {"summary": str(data.get("summary") or ""), "added": len(out)}


_analyse_jobs: dict[str, dict[str, Any]] = {}


class RuleBody(BaseModel):
    title: Optional[str] = None
    text: Optional[str] = None
    category: Optional[str] = None
    status: Optional[str] = None


class AnalyseBody(BaseModel):
    item_ids: list[str] = []


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

class NoteBody(BaseModel):
    title: str = ""
    note: str = ""


class PatchBody(BaseModel):
    title: Optional[str] = None
    note: Optional[str] = None
    use: Optional[bool] = None


def register(router: APIRouter, project_dir_of) -> None:
    @router.get("/{project_id}/inspiration")
    async def board_list(project_id: str) -> dict:
        return {"items": [_public(i) for i in _load(project_dir_of(project_id))]}

    @router.post("/{project_id}/inspiration/file")
    async def board_add_file(project_id: str, request: Request, name: str = "") -> dict:
        pd = project_dir_of(project_id)
        kind = _kind_of(name)
        if not kind:
            raise HTTPException(status_code=422, detail="Add a picture (jpg, png, webp) or a video (mp4, mov, webm, mkv, m4v)")
        safe = re.sub(r"[^\w.\- ]", "_", Path(name).name)[:80] or f"file{Path(name).suffix}"
        iid = uuid.uuid4().hex[:8]
        d = _dir(pd)
        d.mkdir(parents=True, exist_ok=True)
        target = d / f"{iid}-{safe}"
        size = 0
        try:
            with open(target, "wb") as f:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise HTTPException(status_code=413, detail="That file is too big for the board (limit 600 MB)")
                    f.write(chunk)
        except BaseException:
            target.unlink(missing_ok=True)
            raise
        if size == 0:
            target.unlink(missing_ok=True)
            raise HTTPException(status_code=422, detail="The file is empty")
        item = {"id": iid, "kind": kind, "file": target.name, "title": Path(safe).stem, "note": "", "use": True,
                "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        with _lock:
            items = _load(pd)
            items.append(item)
            _save(pd, items)
        return _public(item)

    @router.post("/{project_id}/inspiration/note")
    async def board_add_note(project_id: str, body: NoteBody) -> dict:
        pd = project_dir_of(project_id)
        item = {"id": uuid.uuid4().hex[:8], "kind": "note", "file": None, "title": body.title.strip()[:120] or "Rule",
                "note": body.note, "use": True, "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        with _lock:
            items = _load(pd)
            items.append(item)
            _save(pd, items)
        return _public(item)

    @router.patch("/{project_id}/inspiration/{iid}")
    async def board_patch(project_id: str, iid: str, body: PatchBody) -> dict:
        pd = project_dir_of(project_id)
        with _lock:
            items = _load(pd)
            it = next((i for i in items if i["id"] == iid), None)
            if not it:
                raise HTTPException(status_code=404, detail="unknown item")
            if body.title is not None:
                it["title"] = body.title[:120]
            if body.note is not None:
                it["note"] = body.note
            if body.use is not None:
                it["use"] = body.use
            _save(pd, items)
        return _public(it)

    # ---- rules --------------------------------------------------------
    @router.get("/{project_id}/inspiration-rules")
    async def rules_list(project_id: str) -> dict:
        return {"rules": _rules_load(project_dir_of(project_id))}

    @router.post("/{project_id}/inspiration-rules")
    async def rules_add(project_id: str, body: RuleBody) -> dict:
        pd = project_dir_of(project_id)
        cat = (body.category or "other").lower()
        r = {"id": uuid.uuid4().hex[:8], "category": cat if cat in CATEGORIES else "other", "title": (body.title or "").strip()[:80] or "Rule",
             "text": body.text or "", "status": "active", "source": "written by you", "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        with _lock:
            rules = _rules_load(pd)
            rules.append(r)
            _rules_save(pd, rules)
        return r

    @router.patch("/{project_id}/inspiration-rules/{rid}")
    async def rules_patch(project_id: str, rid: str, body: RuleBody) -> dict:
        pd = project_dir_of(project_id)
        with _lock:
            rules = _rules_load(pd)
            r = next((x for x in rules if x["id"] == rid), None)
            if not r:
                raise HTTPException(status_code=404, detail="unknown rule")
            if body.title is not None:
                r["title"] = body.title[:80]
            if body.text is not None:
                r["text"] = body.text
            if body.category is not None and body.category in CATEGORIES:
                r["category"] = body.category
            if body.status is not None and body.status in ("draft", "active", "off"):
                r["status"] = body.status
            _rules_save(pd, rules)
        return r

    @router.delete("/{project_id}/inspiration-rules/{rid}")
    async def rules_delete(project_id: str, rid: str) -> dict:
        pd = project_dir_of(project_id)
        with _lock:
            _rules_save(pd, [x for x in _rules_load(pd) if x["id"] != rid])
        return {"ok": True}

    @router.post("/{project_id}/inspiration-analyse")
    async def analyse_start(project_id: str, body: AnalyseBody) -> dict:
        pd = project_dir_of(project_id)
        with _lock:
            job = _analyse_jobs.get(project_id)
            if job and job.get("running"):
                raise HTTPException(status_code=409, detail="An analysis is already running")
            jid = uuid.uuid4().hex[:8]
            _analyse_jobs[project_id] = {"id": jid, "running": True, "ok": None, "error": None, "result": None, "started_at": time.time()}

        def work() -> None:
            j = _analyse_jobs[project_id]
            try:
                j["result"] = analyse(pd, body.item_ids or None)
                j["ok"] = True
            except subprocess.TimeoutExpired:
                j["ok"], j["error"] = False, "The analysis took too long. Try fewer references."
            except FileNotFoundError:
                j["ok"], j["error"] = False, "The 'claude' command was not found on this computer."
            except Exception as exc:  # noqa: BLE001  (shown to the user)
                j["ok"], j["error"] = False, str(exc)
            finally:
                j["running"] = False

        threading.Thread(target=work, daemon=True).start()
        return {"id": jid, "running": True}

    @router.get("/{project_id}/inspiration-analyse")
    async def analyse_status(project_id: str) -> dict:
        project_dir_of(project_id)
        return _analyse_jobs.get(project_id) or {"running": False}

    @router.delete("/{project_id}/inspiration/{iid}")
    async def board_delete(project_id: str, iid: str) -> dict:
        pd = project_dir_of(project_id)
        with _lock:
            items = _load(pd)
            it = next((i for i in items if i["id"] == iid), None)
            if not it:
                raise HTTPException(status_code=404, detail="unknown item")
            if it.get("file"):
                (_dir(pd) / it["file"]).unlink(missing_ok=True)
                for f in (_dir(pd) / ".cache").glob(f"{iid}*"):
                    f.unlink(missing_ok=True)
            _save(pd, [i for i in items if i["id"] != iid])
        return {"ok": True}
