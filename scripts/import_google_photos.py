"""Import user-selected Google Photos into a project source-media catalog.

This command opens Google's OAuth and Photos Picker pages in the user's
browser. Only the photos and videos explicitly selected by the user are
downloaded.
"""

from __future__ import annotations

import argparse
import json
import queue
import sys
import threading
import time
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from lib.env_loader import load_env  # noqa: E402
from lib.google_photos import (  # noqa: E402
    GooglePhotosClient,
    GooglePhotosConfig,
    GooglePhotosError,
    TokenStore,
    parse_google_duration,
    picker_autoclose_url,
    public_manifest_item,
)
from scripts.import_media_url import project_dir  # noqa: E402


DEFAULT_TOKEN_FILE = PROJECT_ROOT / ".backlot" / "google-photos-token.json"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Select and import source media with Google Photos Picker."
    )
    parser.add_argument(
        "--project",
        default="first-highlight-video",
        help="Project slug under projects/ (default: first-highlight-video)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=900,
        help="Seconds to wait for OAuth or photo selection (default: 900)",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Print URLs instead of opening them automatically",
    )
    parser.add_argument(
        "--auth-only",
        action="store_true",
        help="Connect Google Photos without opening a Picker session",
    )
    parser.add_argument(
        "--disconnect",
        action="store_true",
        help="Delete the locally stored Google Photos OAuth token",
    )
    parser.add_argument(
        "--keep-session",
        action="store_true",
        help="Do not delete the Google Picker session after import (debugging only)",
    )
    parser.add_argument(
        "--token-file",
        type=Path,
        default=DEFAULT_TOKEN_FILE,
        help=argparse.SUPPRESS,
    )
    return parser


def ensure_authorized(
    client: GooglePhotosClient,
    *,
    timeout: int,
    open_browser: bool,
) -> None:
    if client.is_connected():
        try:
            client.access_token()
            return
        except GooglePhotosError:
            # A revoked or malformed stored token should be replaced by a
            # fresh user authorization.
            client.token_store.delete()

    redirect = urlparse(client.config.redirect_uri)
    if (
        redirect.scheme != "http"
        or redirect.hostname not in {"127.0.0.1", "localhost"}
        or redirect.port is None
    ):
        raise GooglePhotosError(
            "GOOGLE_PHOTOS_REDIRECT_URI must be an http://localhost or "
            "http://127.0.0.1 URL with an explicit port."
        )

    state = client.new_state()
    auth_url = client.authorization_url(state)
    callback_queue: queue.Queue[dict[str, str]] = queue.Queue(maxsize=1)
    expected_path = redirect.path or "/"

    class CallbackHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - stdlib handler contract
            request_url = urlparse(self.path)
            if request_url.path != expected_path:
                self.send_error(404)
                return
            params = parse_qs(request_url.query)
            payload = {
                "state": params.get("state", [""])[0],
                "code": params.get("code", [""])[0],
                "error": params.get("error", [""])[0],
            }
            valid_state = payload["state"] == state
            if valid_state:
                try:
                    callback_queue.put_nowait(payload)
                except queue.Full:
                    pass
            ok = bool(payload["code"]) and valid_state
            body = (
                "<h1>Google Photos connected</h1>"
                "<p>You can close this tab and return to OpenMontage.</p>"
                if ok
                else "<h1>Connection failed</h1><p>Return to OpenMontage for details.</p>"
            )
            encoded = (
                "<!doctype html><meta charset=utf-8><title>OpenMontage</title>"
                f"<body style='font:16px system-ui;padding:3rem'>{body}</body>"
            ).encode()
            self.send_response(200 if ok else 400)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    server = ThreadingHTTPServer((redirect.hostname, redirect.port), CallbackHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    try:
        _present_url("Connect Google Photos", auth_url, open_browser)
        try:
            callback = callback_queue.get(timeout=timeout)
        except queue.Empty as exc:
            raise GooglePhotosError(
                f"Timed out after {timeout} seconds waiting for Google OAuth."
            ) from exc
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)

    if callback["state"] != state:
        raise GooglePhotosError("Google OAuth state did not match; authorization rejected.")
    if callback["error"]:
        raise GooglePhotosError(f"Google OAuth was not completed: {callback['error']}")
    if not callback["code"]:
        raise GooglePhotosError("Google OAuth callback did not include a code.")
    client.exchange_code(callback["code"])


def wait_for_selection(
    client: GooglePhotosClient,
    picker_session: dict[str, Any],
    *,
    timeout: int,
    open_browser: bool,
) -> dict[str, Any]:
    picker_url = picker_autoclose_url(str(picker_session["pickerUri"]))
    _present_url("Choose photos and videos", picker_url, open_browser)

    config = picker_session.get("pollingConfig") or {}
    poll_interval = max(1.0, parse_google_duration(config.get("pollInterval"), 3.0))
    api_timeout = parse_google_duration(config.get("timeoutIn"), float(timeout))
    deadline = time.monotonic() + min(float(timeout), api_timeout)

    while time.monotonic() < deadline:
        current = client.get_picker_session(str(picker_session["id"]))
        if current.get("mediaItemsSet") is True:
            return current
        current_config = current.get("pollingConfig") or {}
        poll_interval = max(
            1.0,
            parse_google_duration(current_config.get("pollInterval"), poll_interval),
        )
        time.sleep(min(poll_interval, max(0.0, deadline - time.monotonic())))
    raise GooglePhotosError(
        f"Timed out after {min(timeout, int(api_timeout))} seconds waiting for "
        "Google Photos selection."
    )


def import_selection(
    client: GooglePhotosClient,
    picker_session: dict[str, Any],
    *,
    project_id: str,
) -> dict[str, Any]:
    session_id = str(picker_session["id"])
    items = client.list_media_items(session_id)
    if not items:
        raise GooglePhotosError("No photos or videos were selected.")

    catalog_id = _safe_catalog_id(session_id)
    destination = (
        project_dir(project_id)
        / "source-media"
        / "google-photos"
        / catalog_id
    )
    failures: list[dict[str, Any]] = []
    total = len(items)
    print(f"Downloading {total} selected items to {destination} ...", flush=True)
    imported = client.download_media_items(items, destination, failures=failures)
    manifest = {
        "version": "1.0",
        "source": "google_photos_picker",
        "session_id": session_id,
        "imported_at": datetime.now(timezone.utc).isoformat(),
        "project_id": project_id,
        "item_count": len(imported),
        "selected_count": total,
        "failed_items": failures,
        "selected_items": [public_manifest_item(item) for item in items],
        "imports": imported,
    }
    manifest_path = destination / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    if failures:
        print(
            f"Warning: {len(failures)} of {total} items failed after retries; "
            "see failed_items in manifest.json and re-run to fetch them.",
            file=sys.stderr,
        )
    return {
        "success": not failures,
        "failed_count": len(failures),
        "project_id": project_id,
        "catalog_dir": str(destination),
        "manifest": str(manifest_path),
        "item_count": len(imported),
        "files": [item["path"] for item in imported],
    }


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.timeout <= 0:
        raise SystemExit("--timeout must be greater than zero")

    load_env(PROJECT_ROOT)
    token_store = TokenStore(args.token_file.resolve())
    if args.disconnect:
        removed = token_store.delete()
        print("Google Photos disconnected." if removed else "Google Photos was not connected.")
        return 0

    try:
        config = GooglePhotosConfig.from_env()
        client = GooglePhotosClient(config, token_store)
        ensure_authorized(
            client,
            timeout=args.timeout,
            open_browser=not args.no_browser,
        )
        if args.auth_only:
            print("Google Photos connected.")
            return 0

        picker_session = client.create_picker_session()
        try:
            wait_for_selection(
                client,
                picker_session,
                timeout=args.timeout,
                open_browser=not args.no_browser,
            )
            result = import_selection(
                client,
                picker_session,
                project_id=args.project,
            )
        finally:
            if not args.keep_session:
                try:
                    client.delete_picker_session(str(picker_session["id"]))
                except GooglePhotosError as cleanup_error:
                    print(
                        f"Warning: Picker session cleanup failed: {cleanup_error}",
                        file=sys.stderr,
                    )
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    except (GooglePhotosError, ValueError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


def _present_url(label: str, url: str, open_browser: bool) -> None:
    print(f"{label}: {url}")
    if open_browser and not webbrowser.open(url, new=1, autoraise=True):
        print("The browser did not open automatically; use the URL above.")


def _safe_catalog_id(session_id: str) -> str:
    import hashlib

    return "picker-" + hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:12]


if __name__ == "__main__":
    raise SystemExit(main())
