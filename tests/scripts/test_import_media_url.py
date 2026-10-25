from pathlib import Path

import pytest

from scripts.import_media_url import project_dir, source_id_from_url


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://www.youtube.com/watch?v=hTWKbfoikeg", "youtube-hTWKbfoikeg"),
        ("https://youtu.be/hTWKbfoikeg?t=12", "youtube-hTWKbfoikeg"),
        ("https://youtube.com/shorts/hTWKbfoikeg", "youtube-hTWKbfoikeg"),
        ("https://youtube.com/embed/hTWKbfoikeg", "youtube-hTWKbfoikeg"),
    ],
)
def test_source_id_extracts_youtube_id(url: str, expected: str) -> None:
    assert source_id_from_url(url) == expected


def test_source_id_has_deterministic_fallback() -> None:
    url = "https://example.com/media/a?quality=high"
    assert source_id_from_url(url) == source_id_from_url(url)
    assert source_id_from_url(url).startswith("url-")


def test_project_dir_rejects_path_traversal() -> None:
    with pytest.raises(ValueError):
        project_dir("../outside")


def test_project_dir_resolves_beneath_projects() -> None:
    path = project_dir("my-video_2")
    assert path.name == "my-video_2"
    assert path.parent.name == "projects"
