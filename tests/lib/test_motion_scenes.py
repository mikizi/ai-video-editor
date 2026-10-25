"""Motion scenes: templates, scene workspace, timeline clip (no HyperFrames render)."""

from __future__ import annotations

import json

import pytest

from lib import motion_scenes as M
from lib import timeline as T


@pytest.fixture()
def project(tmp_path, monkeypatch):
    monkeypatch.setattr(M, "PROJECTS_DIR", tmp_path)
    p = tmp_path / "demo"
    (p / "public" / "media").mkdir(parents=True)
    (p / "public" / "media" / "a.jpg").write_bytes(b"jpg")
    return p


def test_templates_have_valid_metadata():
    templates = M.list_templates()
    assert {"title-card", "chapter-card", "photo-collage", "outro"} <= {t["id"] for t in templates}
    for t in templates:
        html = (M.TEMPLATES_DIR / t["id"] / "index.html").read_text(encoding="utf-8")
        assert "__W__" in html and "__DUR__" in html
        ids = {f["id"] for f in t["fields"]}
        for fid in ids:  # every field is a declared composition variable
            assert f'"id":"{fid}"' in html


def test_create_scene_fills_placeholders_and_copies_photos(project):
    sc = M.create_scene("demo", "photo-collage", "col-1", {"photo1": "media/a.jpg", "caption": "Hi"},
                        seconds=4.01, fmt={"width": 1080, "height": 1920})
    work = sc["dir"]
    html = (work / "index.html").read_text(encoding="utf-8")
    assert "__W__" not in html and "__DUR__" not in html and 'data-width="1080"' in html
    assert (work / "assets" / "a.jpg").exists() and (work / "motion-kit.js").exists()
    assert json.loads((work / "vars.json").read_text())["photo1"] == "a.jpg"
    assert sc["seconds"] == pytest.approx(round(4.01 * 30) / 30)  # whole frames
    # Re-editing keeps the already-copied photo even though value is now a bare file name.
    sc2 = M.create_scene("demo", "photo-collage", "col-1", {"photo1": "a.jpg"})
    assert sc2["generated"]["params"]["photo1"] == "a.jpg"


def test_bad_inputs_rejected(project):
    with pytest.raises(M.MotionSceneError):
        M.create_scene("demo", "nope")
    with pytest.raises(M.MotionSceneError):
        M.create_scene("demo", "title-card", "../escape")
    with pytest.raises(M.MotionSceneError):
        M.create_scene("demo", "photo-collage", "x", {"photo1": "media/missing.jpg"})
    with pytest.raises(M.MotionSceneError):
        M.create_scene("demo", "photo-collage", "x", {"photo1": "../../etc/passwd"})


def test_scene_clip_is_valid_timeline_clip(project):
    sc = M.create_scene("demo", "title-card", "t-1", {"title": "Hi"})
    meta = M.read_scene("demo", "t-1")
    clip = M.scene_clip("t-1", meta, 3.5)
    tl = {"version": "1.0", "clips": [clip]}
    T.validate(tl)
    assert clip["generated"]["params"]["title"] == "Hi" and sc["scene"] == "t-1"
    assert M.new_scene_id("demo", "title-card") == "title-card-1"
