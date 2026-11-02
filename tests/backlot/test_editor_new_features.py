"""Tests for the editor additions: icons, the "thirds" transition, layer pop, expand-to-cut fields, favorites, folder removal."""
from pathlib import Path

import pytest

from lib import timeline as T


def _tl(**extra):
    tl = {"version": "1.0", "title": "t", "format": {"width": 1080, "height": 1920, "fps": 30},
          "style": {"font": "Heebo", "accent": "#FFD400", "grade": "none", "vignette": False, "beat_pulse": 0, "background": "#000000"},
          "opener": None, "clips": [], "texts": [], "music": None, "beats": []}
    tl.update(extra)
    return tl


def test_icon_layer_is_valid_and_png_is_made(tmp_path):
    from backlot import editor_icons
    (tmp_path / "public").mkdir()
    layer = editor_icons.expand_layer(tmp_path, {"id": "l1", "lane": 2, "icon": "check", "color": "#00aa55", "start": 1, "end": 3, "scale": 0.2, "x": 0.3, "y": -0.3, "pop": 0.6})
    assert layer["kind"] == "image" and layer["transform"]["scale"] == 0.2 and layer["pop"] == 0.6 and "icon" not in layer
    assert (tmp_path / "public" / layer["src"]).is_file()
    T.validate(_tl(layers=[layer]))


def test_unknown_icon_is_refused(tmp_path):
    from backlot import editor_icons
    (tmp_path / "public").mkdir()
    with pytest.raises((ValueError, OSError)):
        editor_icons.make_icon(tmp_path, "not-a-shape")


def test_thirds_transition_and_cut_from_validate():
    clip = {"id": "c1", "src": "media/a.mp4", "kind": "video", "in": 0, "out": 2, "cut_from": {"in": 0, "out": 5}, "transition": {"type": "thirds", "seconds": 0.8}}
    T.validate(_tl(clips=[clip]))


def test_thirds_expression_has_no_shared_registers():
    from backlot import quick_export
    assert "st(" not in quick_export.THIRDS_EXPR and "ld(" not in quick_export.THIRDS_EXPR   # shared between threads: turns into noise
    assert "b0(" in quick_export.THIRDS_EXPR and "a2(" in quick_export.THIRDS_EXPR


def test_background_effect_fields_validate():
    clip = {"id": "c1", "src": "media/a.mp4", "kind": "video", "in": 0, "out": 2, "bgfx": {"mode": "blur", "amount": 10, "status": "todo"}}
    T.validate(_tl(clips=[clip]))


@pytest.fixture
def client(tmp_path, monkeypatch):
    import backlot.editor_api as E
    import lib.checkpoint as C
    from fastapi.testclient import TestClient
    from backlot.server import create_app
    monkeypatch.setattr(E, "PROJECTS_DIR", tmp_path)
    monkeypatch.setattr(C, "PROJECTS_DIR", tmp_path)
    return TestClient(create_app())


def test_favorites_and_folder_removal(client, tmp_path):
    assert client.post("/api/editor/projects", json={"title": "Fav Test"}).status_code == 200
    pid = "fav-test"
    assert client.post(f"/api/editor/{pid}/favorites", json={"src": "media/x/a.mp4", "on": True}).json()["favorites"] == ["media/x/a.mp4"]
    assert client.post(f"/api/editor/{pid}/favorites", json={"src": "media/x/a.mp4", "on": False}).json()["favorites"] == []
    media = tmp_path / pid / "public" / "media" / "stuff"
    media.mkdir(parents=True)
    (media / "a.mp4").write_bytes(b"1")
    r = client.post(f"/api/editor/{pid}/folder/remove", json={"folder": "stuff"})
    assert r.status_code == 200 and r.json()["files"] == 1 and not media.exists()      # moved to the trash folder, not erased
    assert any((tmp_path / pid / "trash").iterdir())
    assert client.post(f"/api/editor/{pid}/folder/remove", json={"folder": "../.."}).status_code in (404, 422)
