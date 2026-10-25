"""Google Photos Picker API client for user-selected source media.

The Photos Picker API is intentionally user-driven: an OAuth user grants the
minimal Picker scope, selects specific items in Google's UI, and OpenMontage
downloads only those selected bytes.  Service accounts are not supported by
the Google Photos APIs.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import quote, urlencode

import requests


PICKER_SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
PICKER_API = "https://photospicker.googleapis.com/v1"
DOWNLOAD_ATTEMPTS = 4
DEFAULT_REDIRECT_URI = "http://127.0.0.1:8765/oauth2/callback"
TOKEN_EXPIRY_SKEW_SECONDS = 60


class GooglePhotosError(RuntimeError):
    """Actionable Google Photos auth, API, or import failure."""


@dataclass(frozen=True)
class GooglePhotosConfig:
    client_id: str
    client_secret: str
    redirect_uri: str = DEFAULT_REDIRECT_URI

    @classmethod
    def from_env(cls) -> "GooglePhotosConfig":
        client_id = os.environ.get("GOOGLE_PHOTOS_CLIENT_ID", "").strip()
        client_secret = os.environ.get("GOOGLE_PHOTOS_CLIENT_SECRET", "").strip()
        redirect_uri = (
            os.environ.get("GOOGLE_PHOTOS_REDIRECT_URI", "").strip()
            or DEFAULT_REDIRECT_URI
        )
        missing = [
            name
            for name, value in (
                ("GOOGLE_PHOTOS_CLIENT_ID", client_id),
                ("GOOGLE_PHOTOS_CLIENT_SECRET", client_secret),
            )
            if not value
        ]
        if missing:
            raise GooglePhotosError(
                "Google Photos OAuth is not configured. Add "
                + " and ".join(missing)
                + " to .env, enable the Google Photos Picker API, and register "
                f"{redirect_uri} as an authorized redirect URI."
            )
        return cls(client_id, client_secret, redirect_uri)


class TokenStore:
    """Small local OAuth token store; the default location is gitignored."""

    def __init__(self, path: Path):
        self.path = path

    def load(self) -> dict[str, Any]:
        if not self.path.is_file():
            return {}
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise GooglePhotosError(
                f"Could not read Google Photos token file {self.path}: {exc}"
            ) from exc
        if not isinstance(value, dict):
            raise GooglePhotosError(
                f"Google Photos token file {self.path} must contain a JSON object."
            )
        return value

    def save(self, token: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(self.path.suffix + ".tmp")
        temp.write_text(json.dumps(token, indent=2) + "\n", encoding="utf-8")
        try:
            os.chmod(temp, 0o600)
        except OSError:
            pass
        temp.replace(self.path)

    def delete(self) -> bool:
        try:
            self.path.unlink()
            return True
        except FileNotFoundError:
            return False


class GooglePhotosClient:
    """OAuth and REST operations for the Google Photos Picker API."""

    def __init__(
        self,
        config: GooglePhotosConfig,
        token_store: TokenStore,
        *,
        session: requests.Session | None = None,
        clock: Callable[[], float] = time.time,
    ):
        self.config = config
        self.token_store = token_store
        self.session = session or requests.Session()
        self.clock = clock

    @staticmethod
    def new_state() -> str:
        return secrets.token_urlsafe(32)

    def authorization_url(self, state: str) -> str:
        query = urlencode(
            {
                "client_id": self.config.client_id,
                "redirect_uri": self.config.redirect_uri,
                "response_type": "code",
                "scope": PICKER_SCOPE,
                "access_type": "offline",
                "include_granted_scopes": "true",
                "prompt": "consent",
                "state": state,
            }
        )
        return f"{AUTH_URL}?{query}"

    def exchange_code(self, code: str) -> dict[str, Any]:
        response = self.session.post(
            TOKEN_URL,
            data={
                "code": code,
                "client_id": self.config.client_id,
                "client_secret": self.config.client_secret,
                "redirect_uri": self.config.redirect_uri,
                "grant_type": "authorization_code",
            },
            timeout=30,
        )
        token = self._json_response(response, "OAuth code exchange")
        if not token.get("access_token"):
            raise GooglePhotosError("Google OAuth did not return an access token.")
        self._save_token_response(token)
        return self.token_store.load()

    def access_token(self) -> str:
        token = self.token_store.load()
        access_token = token.get("access_token")
        expires_at = float(token.get("expires_at") or 0)
        if access_token and expires_at > self.clock() + TOKEN_EXPIRY_SKEW_SECONDS:
            return str(access_token)

        refresh_token = token.get("refresh_token")
        if not refresh_token:
            raise GooglePhotosError(
                "Google Photos is not connected. Run the importer to authorize access."
            )

        response = self.session.post(
            TOKEN_URL,
            data={
                "client_id": self.config.client_id,
                "client_secret": self.config.client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
            timeout=30,
        )
        refreshed = self._json_response(response, "OAuth token refresh")
        if not refreshed.get("access_token"):
            raise GooglePhotosError("Google OAuth refresh did not return an access token.")
        refreshed.setdefault("refresh_token", refresh_token)
        self._save_token_response(refreshed)
        return str(refreshed["access_token"])

    def is_connected(self) -> bool:
        token = self.token_store.load()
        return bool(token.get("refresh_token") or token.get("access_token"))

    def create_picker_session(self) -> dict[str, Any]:
        response = self.session.post(
            f"{PICKER_API}/sessions",
            headers=self._headers(),
            json={},
            timeout=30,
        )
        result = self._json_response(response, "create Picker session")
        if not result.get("id") or not result.get("pickerUri"):
            raise GooglePhotosError(
                "Google Photos created an incomplete Picker session."
            )
        return result

    def get_picker_session(self, session_id: str) -> dict[str, Any]:
        response = self.session.get(
            f"{PICKER_API}/sessions/{quote(session_id, safe='')}",
            headers=self._headers(),
            timeout=30,
        )
        return self._json_response(response, "read Picker session")

    def delete_picker_session(self, session_id: str) -> None:
        response = self.session.delete(
            f"{PICKER_API}/sessions/{quote(session_id, safe='')}",
            headers=self._headers(),
            timeout=30,
        )
        if response.status_code not in (200, 204, 404):
            self._json_response(response, "delete Picker session")

    def list_media_items(self, session_id: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        page_token = ""
        while True:
            params: dict[str, Any] = {
                "sessionId": session_id,
                "pageSize": 100,
            }
            if page_token:
                params["pageToken"] = page_token
            response = self.session.get(
                f"{PICKER_API}/mediaItems",
                headers=self._headers(),
                params=params,
                timeout=30,
            )
            page = self._json_response(response, "list selected media")
            page_items = page.get("mediaItems") or []
            if not isinstance(page_items, list):
                raise GooglePhotosError(
                    "Google Photos returned an invalid mediaItems payload."
                )
            items.extend(item for item in page_items if isinstance(item, dict))
            page_token = str(page.get("nextPageToken") or "")
            if not page_token:
                return items

    def download_media_items(
        self,
        items: Iterable[dict[str, Any]],
        destination: Path,
        failures: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        destination.mkdir(parents=True, exist_ok=True)
        imported: list[dict[str, Any]] = []
        for index, item in enumerate(items, start=1):
            media_file = item.get("mediaFile") or {}
            base_url = str(media_file.get("baseUrl") or "")
            mime_type = str(media_file.get("mimeType") or "")
            media_type = str(item.get("type") or "")
            is_video = media_type == "VIDEO" or mime_type.startswith("video/")
            if not base_url:
                raise GooglePhotosError(
                    f"Selected item {item.get('id') or index} has no download URL."
                )

            if is_video:
                video_metadata = (
                    (media_file.get("mediaFileMetadata") or {}).get("videoMetadata")
                    or {}
                )
                processing = str(video_metadata.get("processingStatus") or "")
                if processing and processing != "READY":
                    not_ready = (
                        f"Video {media_file.get('filename') or item.get('id')} "
                        f"is not ready in Google Photos (status: {processing})."
                    )
                    if failures is None:
                        raise GooglePhotosError(not_ready)
                    failures.append(
                        {
                            "id": item.get("id"),
                            "filename": media_file.get("filename"),
                            "error": not_ready,
                        }
                    )
                    continue

            filename = safe_media_filename(
                str(media_file.get("filename") or ""),
                mime_type=mime_type,
                fallback=f"google-photo-{index}",
            )
            target = unique_path(destination / filename)
            download_url = f"{base_url}={'dv' if is_video else 'd'}"
            last_error: Exception | None = None
            for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
                try:
                    self._download_one(download_url, target, filename)
                    last_error = None
                    break
                except (GooglePhotosError, requests.RequestException, OSError) as exc:
                    last_error = exc
                    if attempt < DOWNLOAD_ATTEMPTS:
                        time.sleep(min(30, 3 * attempt))
            if last_error is not None:
                if failures is None:
                    raise GooglePhotosError(str(last_error)) from last_error
                failures.append(
                    {
                        "id": item.get("id"),
                        "filename": filename,
                        "error": str(last_error),
                    }
                )
                continue

            imported.append(
                {
                    "id": item.get("id"),
                    "type": "video" if is_video else "image",
                    "create_time": item.get("createTime"),
                    "filename": target.name,
                    "path": str(target),
                    "mime_type": mime_type,
                    "size_bytes": target.stat().st_size,
                    "media_file_metadata": media_file.get("mediaFileMetadata") or {},
                }
            )
        return imported

    def _download_one(self, download_url: str, target: Path, filename: str) -> None:
        """Stream one item to ``target``; token is refreshed per call."""
        headers = {"Authorization": f"Bearer {self.access_token()}"}
        response = self.session.get(
            download_url,
            headers=headers,
            stream=True,
            timeout=(15, 300),
        )
        try:
            if not response.ok:
                raise GooglePhotosError(
                    f"Download {filename} failed ({response.status_code}): "
                    f"{_response_detail(response)}"
                )
            partial = target.with_suffix(target.suffix + ".part")
            try:
                with partial.open("wb") as handle:
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            handle.write(chunk)
                partial.replace(target)
            except Exception:
                partial.unlink(missing_ok=True)
                raise
        finally:
            response.close()

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.access_token()}",
            "Content-Type": "application/json",
        }

    def _save_token_response(self, response: dict[str, Any]) -> None:
        previous = self.token_store.load()
        token = {
            **previous,
            **response,
            "expires_at": self.clock() + float(response.get("expires_in") or 3600),
        }
        # OAuth responses can include client-facing noise that is not needed
        # for refresh. Keep the granted scope for diagnostics.
        token.pop("id_token", None)
        self.token_store.save(token)

    @staticmethod
    def _json_response(response: requests.Response, operation: str) -> dict[str, Any]:
        if not response.ok:
            raise GooglePhotosError(
                f"Google Photos {operation} failed ({response.status_code}): "
                f"{_response_detail(response)}"
            )
        if response.status_code == 204 or not response.content:
            return {}
        try:
            payload = response.json()
        except ValueError as exc:
            raise GooglePhotosError(
                f"Google Photos {operation} returned invalid JSON."
            ) from exc
        if not isinstance(payload, dict):
            raise GooglePhotosError(
                f"Google Photos {operation} returned an invalid response."
            )
        return payload


def picker_autoclose_url(picker_uri: str) -> str:
    """Append Google's web Picker autoclose suffix exactly once."""
    return picker_uri if picker_uri.rstrip("/").endswith("/autoclose") else (
        picker_uri.rstrip("/") + "/autoclose"
    )


def parse_google_duration(value: Any, default: float) -> float:
    """Parse protobuf Duration strings such as ``3s`` or ``1.5s``."""
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)s\s*", str(value or ""))
    return float(match.group(1)) if match else default


def safe_media_filename(filename: str, *, mime_type: str, fallback: str) -> str:
    """Strip path/control characters while preserving a useful extension."""
    name = Path(filename.replace("\\", "/")).name
    name = re.sub(r"[\x00-\x1f\x7f]", "", name)
    name = re.sub(r"[^A-Za-z0-9._() -]+", "-", name).strip(" .-")
    if not name:
        name = fallback
    if not Path(name).suffix:
        extension = {
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/webp": ".webp",
            "image/heic": ".heic",
            "video/mp4": ".mp4",
            "video/quicktime": ".mov",
        }.get(mime_type, "")
        name += extension
    return name[:180]


def unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    for number in range(2, 10_000):
        candidate = path.with_name(f"{path.stem}-{number}{path.suffix}")
        if not candidate.exists():
            return candidate
    raise GooglePhotosError(f"Could not choose a unique filename for {path.name}.")


def public_manifest_item(item: dict[str, Any]) -> dict[str, Any]:
    """Remove expiring Google byte URLs before persisting import metadata."""
    media_file = item.get("mediaFile") or {}
    return {
        "id": item.get("id"),
        "type": item.get("type"),
        "createTime": item.get("createTime"),
        "mediaFile": {
            "filename": media_file.get("filename"),
            "mimeType": media_file.get("mimeType"),
            "mediaFileMetadata": media_file.get("mediaFileMetadata") or {},
        },
    }


def _response_detail(response: requests.Response) -> str:
    try:
        payload = response.json()
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict):
                return str(error.get("message") or error.get("status") or error)
            if error:
                return str(error)
    except ValueError:
        pass
    text = (response.text or "").strip()
    return text[:500] or "unknown error"
