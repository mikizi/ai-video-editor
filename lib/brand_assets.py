"""Workspace-wide brand asset discovery and project installation.

Brand assets live outside individual projects so every new production can
discover the same approved opener. Project initialization copies the canonical
files into the normal project asset tree, keeping downstream renderers
project-local and deterministic.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

from lib.paths import REPO_ROOT


BRAND_ASSETS_DIR = REPO_ROOT / "brand_assets"
BRAND_MANIFEST_FILENAME = "manifest.json"
CANONICAL_OPENER_FILENAME = "brand-opener.mp4"
PROJECT_OPENER_RELATIVE_PATH = Path("assets/video") / CANONICAL_OPENER_FILENAME


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_manifest(brand_assets_dir: Path) -> dict[str, Any]:
    path = brand_assets_dir / BRAND_MANIFEST_FILENAME
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def sync_brand_assets(
    project_dir: Path,
    *,
    brand_assets_dir: Path = BRAND_ASSETS_DIR,
) -> dict[str, Any]:
    """Copy canonical workspace brand assets into one project.

    Existing matching files are preserved. A different project-local file at
    the canonical path is replaced because the workspace opener is a mandatory
    default; project-specific overrides must use a different path and be
    recorded in the decision log.
    """
    source = brand_assets_dir / CANONICAL_OPENER_FILENAME
    destination = project_dir / PROJECT_OPENER_RELATIVE_PATH
    manifest = _load_manifest(brand_assets_dir)
    opener_manifest = manifest.get("opener", {})

    if not source.is_file():
        return {
            "opener": {
                "status": "missing",
                "source_path": str(source),
                "project_path": PROJECT_OPENER_RELATIVE_PATH.as_posix(),
            }
        }

    source_hash = _sha256(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.is_file() or _sha256(destination) != source_hash:
        shutil.copy2(source, destination)

    return {
        "opener": {
            "status": "ready",
            "source_path": str(source),
            "project_path": PROJECT_OPENER_RELATIVE_PATH.as_posix(),
            "sha256": source_hash,
            "duration_seconds": opener_manifest.get("duration_seconds"),
            "resolution": opener_manifest.get("resolution"),
            "includes_audio": opener_manifest.get("includes_audio", True),
        }
    }


def sync_existing_project(project_dir: Path) -> dict[str, Any]:
    """Install brand assets and refresh an existing project's marker."""
    result = sync_brand_assets(project_dir)
    marker_path = project_dir / "project.json"
    if marker_path.is_file():
        try:
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            marker = {}
        marker["brand_defaults"] = result
        marker_path.write_text(
            json.dumps(marker, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    return result
