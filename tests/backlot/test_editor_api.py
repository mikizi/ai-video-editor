import json

import pytest
from fastapi.testclient import TestClient

import backlot.editor_api as E
from backlot.server import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    proj = tmp_path / "fam"
    media = proj / "public" / "media"
    media.mkdir(parents=True)
    (media / "a.jpg").write_bytes(b"x")
    (media / "b.jpg").write_bytes(b"x")
    monkeypatch.setattr(E, "PROJECTS_DIR", tmp_path)
    return TestClient(create_app())


def test_no_timeline_yet(client):
    r = client.get("/api/editor/fam/timeline")
    assert r.status_code == 200 and r.json()["timeline"] is None


def test_draft_then_save_roundtrip(client, tmp_path):
    r = client.post("/api/editor/fam/draft", json={"aspect": "9:16"})
    assert r.status_code == 200
    tl, mtime = r.json()["timeline"], r.json()["mtime"]
    assert len(tl["clips"]) == 2

    tl["clips"].reverse()
    r = client.put("/api/editor/fam/timeline", json={"timeline": tl, "base_mtime": mtime})
    assert r.status_code == 200, r.text
    on_disk = json.loads((tmp_path / "fam/artifacts/timeline.json").read_text())
    assert [c["src"] for c in on_disk["clips"]] == ["media/b.jpg", "media/a.jpg"]


def test_conflict_when_file_changed(client):
    r = client.post("/api/editor/fam/draft", json={})
    tl = r.json()["timeline"]
    r = client.put("/api/editor/fam/timeline", json={"timeline": tl, "base_mtime": "1"})
    assert r.status_code == 409
    assert r.json()["detail"]["timeline"]["clips"]


def test_invalid_timeline_rejected(client):
    client.post("/api/editor/fam/draft", json={})
    mtime = client.get("/api/editor/fam/timeline").json()["mtime"]
    bad = {"version": "1.0", "clips": [{"id": "x", "src": "media/a.jpg", "kind": "gif"}]}
    r = client.put("/api/editor/fam/timeline", json={"timeline": bad, "base_mtime": mtime})
    assert r.status_code == 422


def test_media_list_and_bad_id(client):
    r = client.get("/api/editor/fam/media")
    assert [m["src"] for m in r.json()["media"]] == ["media/a.jpg", "media/b.jpg"]
    assert client.get("/api/editor/..%2Fx/media").status_code in (400, 404)
    assert client.get("/api/editor/nope/media").status_code == 404


def test_new_project_and_import(client, tmp_path, monkeypatch):
    import lib.checkpoint as C
    monkeypatch.setattr(C, "PROJECTS_DIR", tmp_path)
    r = client.post("/api/editor/projects", json={"title": "Poland Trip!"})
    assert r.status_code == 200 and r.json()["project_id"] == "poland-trip"
    assert client.post("/api/editor/projects", json={"title": "Poland Trip!"}).status_code == 409
    assert client.post("/api/editor/projects", json={"title": "!!!"}).status_code == 422

    # Source folder with real footage, review frames (junk) and a duplicate name.
    src = tmp_path / "poland-trip" / "source-media"
    (src / "picked" / "x_frames").mkdir(parents=True)
    (src / "picked" / "a.jpg").write_bytes(b"1")
    (src / "picked" / "x_frames" / "f.jpg").write_bytes(b"2")
    s = client.get("/api/editor/poland-trip/sources").json()
    assert s["folders"] == [{"path": "source-media/picked", "count": 1}] and s["in_bin"] == 0

    r = client.post("/api/editor/poland-trip/import", json={"folder": "source-media/picked"})
    assert r.json() == {"found": 1, "added": 1}
    again = client.post("/api/editor/poland-trip/import", json={"folder": "source-media/picked"})
    assert again.json()["added"] == 0  # no duplicates
    assert client.get("/api/editor/poland-trip/sources").json()["in_bin"] == 1
    assert client.post("/api/editor/poland-trip/import", json={"folder": "../.."}).status_code in (400, 404)
    assert client.post("/api/editor/poland-trip/import", json={"folder": "/nonexistent-xyz"}).status_code == 404
