import json
from pathlib import Path

import pytest

from lib.brand_assets import (
    CANONICAL_OPENER_FILENAME,
    PROJECT_OPENER_RELATIVE_PATH,
    sync_brand_assets,
)
from lib.checkpoint import init_project


def _brand_fixture(tmp_path: Path, content: bytes = b"approved opener") -> Path:
    brand_dir = tmp_path / "brand_assets"
    brand_dir.mkdir()
    (brand_dir / CANONICAL_OPENER_FILENAME).write_bytes(content)
    (brand_dir / "manifest.json").write_text(
        json.dumps(
            {
                "opener": {
                    "duration_seconds": 4.0,
                    "resolution": "1920x1080",
                    "includes_audio": True,
                }
            }
        ),
        encoding="utf-8",
    )
    return brand_dir


def test_sync_brand_assets_copies_canonical_opener(tmp_path: Path) -> None:
    brand_dir = _brand_fixture(tmp_path)
    project_dir = tmp_path / "projects" / "film"

    result = sync_brand_assets(project_dir, brand_assets_dir=brand_dir)

    installed = project_dir / PROJECT_OPENER_RELATIVE_PATH
    assert installed.read_bytes() == b"approved opener"
    assert result["opener"]["status"] == "ready"
    assert result["opener"]["duration_seconds"] == 4.0
    assert result["opener"]["includes_audio"] is True


def test_sync_brand_assets_repairs_wrong_project_copy(tmp_path: Path) -> None:
    brand_dir = _brand_fixture(tmp_path, b"canonical")
    project_dir = tmp_path / "projects" / "film"
    installed = project_dir / PROJECT_OPENER_RELATIVE_PATH
    installed.parent.mkdir(parents=True)
    installed.write_bytes(b"wrong opener")

    sync_brand_assets(project_dir, brand_assets_dir=brand_dir)

    assert installed.read_bytes() == b"canonical"


def test_sync_brand_assets_reports_missing_source(tmp_path: Path) -> None:
    result = sync_brand_assets(
        tmp_path / "projects" / "film",
        brand_assets_dir=tmp_path / "missing-brand-assets",
    )

    assert result["opener"]["status"] == "missing"


@pytest.mark.skipif(
    not (Path(__file__).resolve().parents[2] / "brand_assets" / "brand-opener.mp4").is_file(),
    reason="no brand opener shipped in this repo",
)
def test_init_project_installs_workspace_opener_and_marks_ready(
    tmp_path: Path,
) -> None:
    project = init_project(
        "film",
        title="Film",
        pipeline_type="cinematic",
        pipeline_dir=tmp_path,
    )

    marker = json.loads((project / "project.json").read_text(encoding="utf-8"))
    assert (project / PROJECT_OPENER_RELATIVE_PATH).is_file()
    assert marker["brand_defaults"]["opener"]["status"] == "ready"
