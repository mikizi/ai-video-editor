"""Make every bundled skill visible to Claude Code.

Claude Code loads skills from `.claude/skills/`, Codex from `.agents/skills/`.
Some skills (montage-thread, hyperframes-*, video-highlight-editor, ...) only live
in `.agents/skills/`; this links them into `.claude/skills/` so both tools see them.

    python scripts/install_skills.py            # project: link missing skills into .claude/skills
    python scripts/install_skills.py --user     # also install all skills for every project (~/.claude/skills)
    python scripts/install_skills.py --list     # show what would be linked
"""

from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / ".agents" / "skills"
PROJECT_DST = ROOT / ".claude" / "skills"


def _skills(*dirs: Path) -> dict[str, Path]:
    out: dict[str, Path] = {}
    for d in dirs:
        if d.is_dir():
            for p in sorted(d.iterdir()):
                if (p / "SKILL.md").is_file():
                    out.setdefault(p.name, p)
    return out


def link_all(skills: dict[str, Path], dst: Path, relative: bool, dry: bool) -> int:
    dst.mkdir(parents=True, exist_ok=True)
    n = 0
    for name, src in skills.items():
        target = dst / name
        if target.exists() or target.is_symlink():
            continue
        n += 1
        print(f"  + {name}")
        if dry:
            continue
        try:
            target.symlink_to(os.path.relpath(src, dst) if relative else src, target_is_directory=True)
        except OSError:  # e.g. Windows without symlink rights
            shutil.copytree(src, target)
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--user", action="store_true", help="also install into ~/.claude/skills")
    ap.add_argument("--list", action="store_true", help="dry run")
    a = ap.parse_args()

    skills = _skills(PROJECT_DST, SRC)
    print(f"Project skills -> {PROJECT_DST}")
    n = link_all({k: v for k, v in skills.items() if v.parent == SRC}, PROJECT_DST, True, a.list)
    print(f"  {n} linked, {len(skills) - n} already present")
    if a.user:
        home = Path.home() / ".claude" / "skills"
        print(f"User skills -> {home}")
        link_all(skills, home, False, a.list)
    print("Restart Claude Code (or start a new session) to pick up new skills.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
