from pathlib import Path

from scripts.import_google_photos import _safe_catalog_id, import_selection


class FakeClient:
    def list_media_items(self, session_id):
        assert session_id == "session/id"
        return [
            {
                "id": "photo-1",
                "type": "PHOTO",
                "mediaFile": {
                    "baseUrl": "https://expiring",
                    "filename": "one.jpg",
                    "mimeType": "image/jpeg",
                },
            }
        ]

    def download_media_items(self, items, destination, failures=None):
        destination.mkdir(parents=True)
        path = destination / "one.jpg"
        path.write_bytes(b"photo")
        return [
            {
                "id": "photo-1",
                "type": "image",
                "filename": "one.jpg",
                "path": str(path),
                "mime_type": "image/jpeg",
                "size_bytes": 5,
            }
        ]


def test_catalog_id_is_stable_and_filesystem_safe() -> None:
    assert _safe_catalog_id("session/id") == _safe_catalog_id("session/id")
    assert "/" not in _safe_catalog_id("session/id")


def test_import_selection_writes_project_manifest(tmp_path: Path, monkeypatch) -> None:
    import scripts.import_google_photos as importer

    monkeypatch.setattr(
        importer,
        "project_dir",
        lambda project_id: tmp_path / "projects" / project_id,
    )

    result = import_selection(
        FakeClient(),
        {"id": "session/id"},
        project_id="my-video",
    )

    manifest = Path(result["manifest"]).read_text(encoding="utf-8")
    assert result["item_count"] == 1
    assert "google_photos_picker" in manifest
    assert "https://expiring" not in manifest
