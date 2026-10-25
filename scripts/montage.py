"""Montage from the terminal: everything the editor can do, as commands (for Claude in chat).

The Backlot editor stays open in the browser and live-updates when timeline.json changes,
so every command here shows up there straight away.

    python scripts/montage.py new "Poland trip"
    python scripts/montage.py import <project> <folder>
    python scripts/montage.py draft <project> [--aspect 9:16] [--overwrite]
    python scripts/montage.py show <project>
    python scripts/montage.py beats <project> [--snap] [--tolerance 0.4] [--force]
    python scripts/montage.py templates
    python scripts/montage.py scene <project> <template> [--set key=value ...] [--seconds N]
                                     [--after CLIP_ID | --at INDEX] [--id SCENE_ID]
    python scripts/montage.py patch <project> <clip-id> '<json>'     # deep-merge into a clip
    python scripts/montage.py move <project> <clip-id> <index>
    python scripts/montage.py remove <project> <clip-id>
    python scripts/montage.py group <project> "<name>" <first-clip-id> <last-clip-id> [--lock]   # compound clip (--lock = fixed length)
    python scripts/montage.py ungroup <project> <group-id-or-name>
    python scripts/montage.py render <project> [--preview]
    python scripts/montage.py comments <project> [--all]               # the review checklist (open first)
    python scripts/montage.py reply <project> <comment-id> "<text>" [--fixed]   # --fixed = ready for the user to approve
    python scripts/montage.py note <project> "<text>" [--clip ID] [--offset S]  # leave a note of your own
"""

from __future__ import annotations

import argparse
import uuid
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lib import beats as B  # noqa: E402
from lib import motion_scenes as M  # noqa: E402
from lib import timeline as T  # noqa: E402
from lib.paths import PROJECTS_DIR  # noqa: E402


def project_dir(project: str) -> Path:
    d = PROJECTS_DIR / project
    if not d.is_dir():
        raise SystemExit(f"unknown project: {project}  (known: {', '.join(sorted(p.name for p in PROJECTS_DIR.iterdir() if p.is_dir()))})")
    return d


def load(project: str) -> tuple[Path, dict]:
    path = T.timeline_path(project_dir(project))
    if not path.exists():
        raise SystemExit(f"{project} has no timeline yet - run: montage.py draft {project}")
    return path, T.load(path)


def find_index(tl: dict, clip_id: str) -> int:
    for i, c in enumerate(tl["clips"]):
        if c["id"] == clip_id:
            return i
    raise SystemExit(f"no clip with id {clip_id!r}. ids: {', '.join(c['id'] for c in tl['clips'])}")


def deep_merge(dst: dict, patch: dict) -> dict:
    for k, v in patch.items():
        if v is None:
            dst.pop(k, None)
        elif isinstance(v, dict) and isinstance(dst.get(k), dict):
            deep_merge(dst[k], v)
        else:
            dst[k] = v
    return dst


# ---------------------------------------------------------------------------

def cmd_new(a: argparse.Namespace) -> None:
    from lib.checkpoint import init_project
    slug = re.sub(r"[^a-z0-9]+", "-", a.title.lower()).strip("-")[:48]
    if not slug:
        raise SystemExit("give the project a name")
    if (PROJECTS_DIR / slug).exists():
        raise SystemExit(f"project already exists: {slug}")
    init_project(slug, title=a.title, pipeline_type="hybrid")
    (PROJECTS_DIR / slug / "public" / "media").mkdir(parents=True, exist_ok=True)
    print(f"created {slug}\neditor: http://127.0.0.1:4750/e/{slug}")


def cmd_import(a: argparse.Namespace) -> None:
    from backlot.editor_api import _import_files, _scan_media
    d = project_dir(a.project)
    folder = Path(a.folder).expanduser()
    if not folder.is_absolute() and not folder.is_dir():  # relative: current directory first, then the project
        folder = d / a.folder
    if not folder.is_dir():
        raise SystemExit(f"folder not found: {folder}")
    files = _scan_media(folder)
    added = _import_files(files, d / "public" / "media")
    print(f"found {len(files)} photos/videos, added {added} to public/media")


def cmd_draft(a: argparse.Namespace) -> None:
    d = project_dir(a.project)
    path = T.timeline_path(d)
    if path.exists() and not a.overwrite:
        raise SystemExit("timeline already exists (use --overwrite to replace it)")
    tl = T.draft_from_media(d, "media", a.aspect)
    T.save(path, tl)
    print(f"draft: {len(tl['clips'])} clips, {T.total_seconds(tl):.1f}s")


def cmd_show(a: argparse.Namespace) -> None:
    _, tl = load(a.project)
    lay = {it["id"]: it for it in T.layout(tl)["items"]}
    fmt = tl.get("format", {})
    print(f"{tl.get('title', a.project)} - {fmt.get('width')}x{fmt.get('height')} - {T.total_seconds(tl):.1f}s total")
    if tl.get("opener"):
        print(f"opener: {tl['opener']['src']} ({tl['opener']['seconds']}s)")
    for i, c in enumerate(tl["clips"]):
        it = lay[c["id"]]
        tr = (c.get("transition") or {}).get("type", "cut")
        extra = []
        if c.get("text"):
            extra.append(f"text={c['text']['value']!r}")
        if c.get("generated"):
            extra.append(f"scene:{c['generated']['template']}")
        if c["kind"] == "video":
            extra.append(f"in={c.get('in', 0)} out={c['out']}")
        print(f"{i:>3} {c['id']:<16} {c['kind']:<5} {it['start']:6.1f}s +{it['duration']:.1f}s  {tr:<10} {c.get('label', '')[:28]:<28} {' '.join(extra)}")
    m = tl.get("music")
    print(f"music: {m['src'] if m else 'none'} | beats: {len(tl.get('beats') or [])} | texts: {len(tl.get('texts') or [])}")


def cmd_beats(a: argparse.Namespace) -> None:
    path, tl = load(a.project)
    music = tl.get("music")
    if not music:
        raise SystemExit("the timeline has no music")
    d = B.detect_song_beats(project_dir(a.project), music["src"], force=a.force)
    opener = tl["opener"]["seconds"] if tl.get("opener") else 0.0
    tl["beats"] = B.to_montage_clock(d["times"], music, opener, 1e4)
    print(f"{d['bpm']} BPM, {d['count']} beats in the song, {len(tl['beats'])} on the timeline")
    if a.snap:
        before = T.total_seconds(tl)
        new = T.snap_to_beats(tl, tolerance=a.tolerance)
        changed = sum(1 for x, y in zip(tl["clips"], new["clips"]) if x != y)
        tl = new
        print(f"snapped {changed} of {len(tl['clips'])} clips to the beat; length {before:.1f}s -> {T.total_seconds(tl):.1f}s")
    T.save(path, tl)


def cmd_templates(a: argparse.Namespace) -> None:
    for t in M.list_templates():
        fields = ", ".join(f"{f['id']}" + ("(photo)" if f["type"] == "photo" else "") for f in t["fields"])
        print(f"{t['id']:<14} {t['default_seconds']}s  {t['description']}\n{'':<14} fields: {fields}")


def cmd_scene(a: argparse.Namespace) -> None:
    params = {}
    for kv in a.set or []:
        k, _, v = kv.partition("=")
        params[k] = v
    path, tl = load(a.project)
    existing = next((c for c in tl["clips"] if a.id and c["id"] == a.id), None)
    if existing and existing.get("generated"):  # re-render an existing scene with changed values
        params = {**existing["generated"]["params"], **params}
    sc = M.create_scene(a.project, a.template, a.id, params, a.seconds)
    lint = M.check_scene(a.project, sc["scene"])
    if not lint["ok"]:
        raise SystemExit("scene check failed:\n" + lint["output"][-1500:])
    clip = M.render_scene(a.project, sc["scene"])["clip"]
    path, tl = load(a.project)   # the render took a while: re-read, so edits made in the editor meanwhile are not overwritten
    existing = next((c for c in tl["clips"] if a.id and c["id"] == a.id), None)
    if existing:
        keep = {k: existing[k] for k in ("transition", "text") if k in existing}
        existing.update(clip)
        existing.update(keep)
        where = f"updated clip {existing['id']}"
    else:
        idx = find_index(tl, a.after) + 1 if a.after else (a.at if a.at is not None else len(tl["clips"]))
        tl["clips"].insert(max(0, min(idx, len(tl["clips"]))), clip)
        where = f"inserted at position {tl['clips'].index(clip)} as {clip['id']}"
    T.save(path, tl)
    print(f"scene {sc['scene']} rendered ({clip['out']}s), {where}")


def cmd_patch(a: argparse.Namespace) -> None:
    path, tl = load(a.project)
    clip = tl["clips"][find_index(tl, a.clip)]
    deep_merge(clip, json.loads(a.json))
    T.save(path, tl)
    print(f"patched {a.clip}")


def _stamp() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _where(tl: dict, cm: dict) -> str:
    if cm.get("clip"):
        c = next((c for c in tl["clips"] if c["id"] == cm["clip"]), None)
        label = (c or {}).get("label") or cm["clip"]
        gid = (c or {}).get("group") or cm.get("group")
        gname = next((g["name"] for g in tl.get("groups", []) if g["id"] == gid), None)
        where = f"clip {cm['clip']} ({label}) +{cm.get('offset', 0):.1f}s" if c else f"clip {cm['clip']} (removed)"
        return where + (f" in '{gname}'" if gname else "")
    return f"editor time {cm.get('at', 0):.1f}s"


def cmd_comments(a: argparse.Namespace) -> None:
    _, tl = load(a.project)
    L = T.layout(tl)
    start = {it["id"]: it["start"] for it in L["items"]}
    def state(c: dict) -> str:   # same five states the editor colours
        if c["status"] != "open":
            return c["status"]
        last = (c.get("replies") or [None])[-1]
        return "new" if not last else ("waiting" if last["by"] == "claude" else "todo")
    order = {"new": 0, "todo": 0, "waiting": 1, "review": 2, "resolved": 3}
    items = sorted(tl.get("comments", []), key=lambda c: (order[state(c)], start.get(c.get("clip"), c.get("at", 0)) + c.get("offset", 0)))
    shown = [c for c in items if a.all or c["status"] != "resolved"]
    if not shown:
        print("no open comments" if not a.all else "no comments")
        return
    mark = {"new": "[ ]", "todo": "[ ]", "waiting": "[?]", "review": "[~]", "resolved": "[x]"}
    for c in shown:
        t = start.get(c.get("clip"), c.get("at", 0)) + c.get("offset", 0)
        print(f"{mark[state(c)]} {c['id']}  {int(t // 60)}:{t % 60:04.1f}  {_where(tl, c)}  [{state(c)}]")
        print(f"      {c['text']}")
        for r in c.get("replies", []):
            print(f"      {'you' if r['by'] == 'claude' else 'user'}: {r['text']}")
    print("\n[ ] new/todo: your turn   [?] you replied or asked, waiting for the user   [~] fixed, waiting for approval   [x] resolved")


def cmd_reply(a: argparse.Namespace) -> None:
    path, tl = load(a.project)
    cm = next((c for c in tl.get("comments", []) if c["id"] == a.comment), None)
    if not cm:
        raise SystemExit(f"no comment {a.comment!r}. ids: {', '.join(c['id'] for c in tl.get('comments', []))}")
    cm.setdefault("replies", []).append({"by": "claude", "text": a.text, "ts": _stamp()}); cm["updated"] = _stamp()
    if a.fixed:
        cm["status"] = "review"   # only the user can resolve it, by approving in the editor
    T.save(path, tl)
    print(f"replied to {a.comment}" + (" - marked as waiting for approval" if a.fixed else ""))


def cmd_note(a: argparse.Namespace) -> None:
    path, tl = load(a.project)
    cm = {"id": "n" + uuid.uuid4().hex[:5], "text": a.text, "status": "open", "created": _stamp(), "updated": _stamp(), "replies": []}
    if a.clip:
        c = tl["clips"][find_index(tl, a.clip)]
        cm.update(clip=a.clip, offset=a.offset or 0)
        if c.get("group"):
            cm["group"] = c["group"]
    else:
        cm["at"] = a.offset or 0
    tl.setdefault("comments", []).append(cm)
    T.save(path, tl)
    print(f"added {cm['id']}")


def cmd_move(a: argparse.Namespace) -> None:
    path, tl = load(a.project)
    find_index(tl, a.clip)
    T.save(path, T.move_clip(tl, a.clip, a.index))
    print(f"moved {a.clip} to position {a.index}")


def cmd_remove(a: argparse.Namespace) -> None:
    path, tl = load(a.project)
    tl["clips"].pop(find_index(tl, a.clip))
    T.save(path, tl)
    print(f"removed {a.clip}; {len(tl['clips'])} clips left")


def cmd_group(a: argparse.Namespace) -> None:
    """Make a compound clip (named group) from a consecutive range of clips: group <project> <name> <first-id> <last-id>."""
    path, tl = load(a.project)
    i, j = sorted((find_index(tl, a.first), find_index(tl, a.last)))
    gid = "g" + a.name.lower().replace(" ", "-")[:12]
    grp = {"id": gid, "name": a.name}
    tl.setdefault("groups", []).append(grp)
    for c in tl["clips"][i:j + 1]:
        c["group"] = gid
    if a.lock:  # fixed length = what the range currently takes
        items = [it for it in T.layout(tl)["items"] if it["id"] in {c["id"] for c in tl["clips"][i:j + 1]}]
        grp["seconds"] = round(items[-1]["end"] - items[0]["start"], 3)
    T.save(path, tl)
    print(f"grouped {j - i + 1} clips as '{a.name}' ({gid})")


def cmd_ungroup(a: argparse.Namespace) -> None:
    path, tl = load(a.project)
    gs = [g for g in tl.get("groups", []) if g["id"] == a.group or g["name"] == a.group]
    for g in gs:
        for c in tl["clips"]:
            if c.get("group") == g["id"]:
                del c["group"]
    tl["groups"] = [g for g in tl.get("groups", []) if g not in gs]
    T.save(path, tl)
    print(f"ungrouped {len(gs)} group(s)")


def cmd_render(a: argparse.Namespace) -> None:
    load(a.project)
    cmd = [sys.executable, str(ROOT / "scripts" / "render_timeline.py"), a.project]
    if a.preview:
        cmd.append("--preview")
    raise SystemExit(subprocess.call(cmd, cwd=ROOT))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, fn, *args):
        p = sub.add_parser(name)
        for spec, kw in args:
            p.add_argument(*spec, **kw)
        p.set_defaults(fn=fn)
        return p

    P = (("project",), {})
    add("new", cmd_new, (("title",), {}))
    add("import", cmd_import, P, (("folder",), {}))
    add("draft", cmd_draft, P, (("--aspect",), {"default": "9:16", "choices": list(T.FORMATS)}), (("--overwrite",), {"action": "store_true"}))
    add("show", cmd_show, P)
    add("beats", cmd_beats, P, (("--snap",), {"action": "store_true"}), (("--tolerance",), {"type": float, "default": 0.4}), (("--force",), {"action": "store_true"}))
    add("templates", cmd_templates)
    add("scene", cmd_scene, P, (("template",), {}), (("--set",), {"action": "append"}), (("--seconds",), {"type": float}),
        (("--after",), {}), (("--at",), {"type": int}), (("--id",), {}))
    add("patch", cmd_patch, P, (("clip",), {}), (("json",), {}))
    add("comments", cmd_comments, P, (("--all",), {"action": "store_true"}))
    add("reply", cmd_reply, P, (("comment",), {}), (("text",), {}), (("--fixed",), {"action": "store_true"}))
    add("note", cmd_note, P, (("text",), {}), (("--clip",), {}), (("--offset",), {"type": float}))
    add("move", cmd_move, P, (("clip",), {}), (("index",), {"type": int}))
    add("remove", cmd_remove, P, (("clip",), {}))
    add("group", cmd_group, P, (("name",), {}), (("first",), {}), (("last",), {}), (("--lock",), {"action": "store_true"}))
    add("ungroup", cmd_ungroup, P, (("group",), {}))
    add("render", cmd_render, P, (("--preview",), {"action": "store_true"}))
    a = ap.parse_args()
    try:
        a.fn(a)
    except (T.TimelineError, M.MotionSceneError, B.BeatError) as exc:
        raise SystemExit(str(exc))


if __name__ == "__main__":
    main()
