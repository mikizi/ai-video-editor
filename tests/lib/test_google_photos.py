from pathlib import Path
from urllib.parse import parse_qs, urlparse

from lib.google_photos import (
    PICKER_SCOPE,
    GooglePhotosClient,
    GooglePhotosConfig,
    TokenStore,
    parse_google_duration,
    picker_autoclose_url,
    public_manifest_item,
    safe_media_filename,
)


class FakeResponse:
    def __init__(self, payload, status_code=200, content=b"json", chunks=None):
        self._payload = payload
        self.status_code = status_code
        self.content = content
        self.ok = 200 <= status_code < 300
        self.text = ""
        self._chunks = list(chunks or [])
        self.closed = False

    def json(self):
        return self._payload

    def iter_content(self, chunk_size):
        assert chunk_size == 1024 * 1024
        yield from self._chunks

    def close(self):
        self.closed = True


class FakeSession:
    def __init__(self, get_responses=None, post_responses=None):
        self.get_responses = list(get_responses or [])
        self.post_responses = list(post_responses or [])
        self.get_calls = []
        self.post_calls = []

    def get(self, url, **kwargs):
        self.get_calls.append((url, kwargs))
        return self.get_responses.pop(0)

    def post(self, url, **kwargs):
        self.post_calls.append((url, kwargs))
        return self.post_responses.pop(0)


def test_authorization_url_requests_minimal_picker_scope(tmp_path: Path) -> None:
    client = GooglePhotosClient(
        GooglePhotosConfig("client", "secret"),
        TokenStore(tmp_path / "token.json"),
    )
    query = parse_qs(urlparse(client.authorization_url("csrf-state")).query)

    assert query["scope"] == [PICKER_SCOPE]
    assert query["state"] == ["csrf-state"]
    assert query["access_type"] == ["offline"]
    assert query["prompt"] == ["consent"]


def test_expired_access_token_is_refreshed_and_saved(tmp_path: Path) -> None:
    store = TokenStore(tmp_path / "token.json")
    store.save(
        {
            "access_token": "expired",
            "refresh_token": "refresh-me",
            "expires_at": 10,
        }
    )
    session = FakeSession(
        post_responses=[
            FakeResponse({"access_token": "fresh", "expires_in": 3600})
        ]
    )
    client = GooglePhotosClient(
        GooglePhotosConfig("client", "secret"),
        store,
        session=session,
        clock=lambda: 100,
    )

    assert client.access_token() == "fresh"
    assert store.load()["refresh_token"] == "refresh-me"
    assert store.load()["expires_at"] == 3700


def test_list_media_items_follows_page_tokens(tmp_path: Path) -> None:
    store = TokenStore(tmp_path / "token.json")
    store.save({"access_token": "token", "expires_at": 9999})
    session = FakeSession(
        get_responses=[
            FakeResponse(
                {"mediaItems": [{"id": "one"}], "nextPageToken": "page-2"}
            ),
            FakeResponse({"mediaItems": [{"id": "two"}]}),
        ]
    )
    client = GooglePhotosClient(
        GooglePhotosConfig("client", "secret"),
        store,
        session=session,
        clock=lambda: 0,
    )

    assert [item["id"] for item in client.list_media_items("session")] == [
        "one",
        "two",
    ]
    assert session.get_calls[1][1]["params"]["pageToken"] == "page-2"


def test_download_media_items_uses_picker_download_suffixes(tmp_path: Path) -> None:
    store = TokenStore(tmp_path / "token.json")
    store.save({"access_token": "token", "expires_at": 9999})
    session = FakeSession(
        get_responses=[
            FakeResponse({}, content=b"photo", chunks=[b"photo"]),
            FakeResponse({}, content=b"video", chunks=[b"video"]),
        ]
    )
    client = GooglePhotosClient(
        GooglePhotosConfig("client", "secret"),
        store,
        session=session,
        clock=lambda: 0,
    )

    imported = client.download_media_items(
        [
            {
                "id": "one",
                "type": "PHOTO",
                "mediaFile": {
                    "baseUrl": "https://bytes/photo",
                    "filename": "one.jpg",
                    "mimeType": "image/jpeg",
                },
            },
            {
                "id": "two",
                "type": "VIDEO",
                "mediaFile": {
                    "baseUrl": "https://bytes/video",
                    "filename": "two.mp4",
                    "mimeType": "video/mp4",
                    "mediaFileMetadata": {
                        "videoMetadata": {"processingStatus": "READY"}
                    },
                },
            },
        ],
        tmp_path / "media",
    )

    assert [call[0] for call in session.get_calls] == [
        "https://bytes/photo=d",
        "https://bytes/video=dv",
    ]
    assert all(
        call[1]["headers"]["Authorization"] == "Bearer token"
        for call in session.get_calls
    )
    assert [Path(item["path"]).read_bytes() for item in imported] == [
        b"photo",
        b"video",
    ]


def test_manifest_item_never_persists_expiring_base_url() -> None:
    item = {
        "id": "photo",
        "type": "PHOTO",
        "mediaFile": {
            "baseUrl": "https://secret-byte-url",
            "filename": "photo.jpg",
            "mimeType": "image/jpeg",
            "mediaFileMetadata": {"width": "100"},
        },
    }

    persisted = public_manifest_item(item)

    assert "baseUrl" not in persisted["mediaFile"]
    assert persisted["mediaFile"]["filename"] == "photo.jpg"


def test_picker_helpers_and_filename_safety() -> None:
    assert picker_autoclose_url("https://photos.google.com/picker/session") == (
        "https://photos.google.com/picker/session/autoclose"
    )
    assert picker_autoclose_url(
        "https://photos.google.com/picker/session/autoclose"
    ).endswith("/autoclose")
    assert parse_google_duration("2.5s", 9) == 2.5
    assert parse_google_duration("bad", 9) == 9
    assert safe_media_filename(
        "../../holiday?.jpg", mime_type="image/jpeg", fallback="photo"
    ) == "holiday-.jpg"
    assert safe_media_filename(
        "", mime_type="video/mp4", fallback="clip"
    ) == "clip.mp4"


def test_download_retries_then_records_failure(tmp_path, monkeypatch):
    """A failing item is retried, recorded in failures, and does not abort the rest."""
    import lib.google_photos as gp

    monkeypatch.setattr(gp.time, "sleep", lambda _s: None)
    calls = {"bad": 0}

    class Resp:
        def __init__(self, ok):
            self.ok = ok
            self.status_code = 200 if ok else 500
            self.text = "boom"

        def iter_content(self, chunk_size):
            yield b"data"

        def json(self):
            return {}

        def close(self):
            pass

    class Session:
        def get(self, url, **_kw):
            if "bad" in url:
                calls["bad"] += 1
                return Resp(False)
            return Resp(True)

    client = gp.GooglePhotosClient.__new__(gp.GooglePhotosClient)
    client.session = Session()
    client.access_token = lambda: "tok"
    items = [
        {"id": "1", "type": "PHOTO", "mediaFile": {"baseUrl": "https://x/bad", "mimeType": "image/jpeg", "filename": "a.jpg"}},
        {"id": "2", "type": "PHOTO", "mediaFile": {"baseUrl": "https://x/good", "mimeType": "image/jpeg", "filename": "b.jpg"}},
    ]
    failures = []
    imported = client.download_media_items(items, tmp_path, failures=failures)
    assert [i["filename"] for i in imported] == ["b.jpg"]
    assert failures and failures[0]["filename"] == "a.jpg"
    assert calls["bad"] == gp.DOWNLOAD_ATTEMPTS
