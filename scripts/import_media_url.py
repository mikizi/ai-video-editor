"""Import a video, audio track, subtitles, or metadata from a media URL.

Each URL gets a stable project-local catalog directory so repeated imports are
idempotent and different URLs never overwrite one another.

Examples:
    python scripts/import_media_url.py "https://youtu.be/..." --kind video
    python scripts/import_media_url.py "https://youtu.be/..." --kind audio
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SAFE_PROJECT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
SAFE_SOURCE_ID = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
KIND_TO_FORMAT = {
    "video": "video",
    "audio": "audio_only",
    "subtitles": "subtitles_only",
    "metadata": "metadata_only",
}


def source_id_from_url(url: str) -> str:
    """Return a stable, filesystem-safe source identifier for a URL."""
    parsed = urlparse(url)
    host = parsed.netloc.lower().removeprefix("www.")

    candidate = ""
    if host in {"youtube.com", "m.youtube.com", "music.youtube.com"}:
        candidate = parse_qs(parsed.query).get("v", [""])[0]
        if not candidate:
            parts = [part for part in parsed.path.split("/") if part]
            if len(parts) >= 2 and parts[0] in {"shorts", "embed", "live"}:
                candidate = parts[1]
    elif host == "youtu.be":
        candidate = parsed.path.strip("/").split("/", 1)[0]

    if candidate and SAFE_SOURCE_ID.fullmatch(candidate):
        return f"youtube-{candidate}"

    digest = hashlib.sha256(url.strip().encode("utf-8")).hexdigest()[:12]
    return f"url-{digest}"


def project_dir(project_id: str) -> Path:
    """Resolve a safe project directory beneath the repository."""
    if not SAFE_PROJECT_ID.fullmatch(project_id):
        raise ValueError(
            "Project must contain only letters, numbers, hyphens, and underscores."
        )
    return PROJECT_ROOT / "projects" / project_id


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Import online media into a project-local URL catalog."
    )
    parser.add_argument("url", help="YouTube, Vimeo, Reel, TikTok, or other supported URL")
    parser.add_argument(
        "--project",
        default="first-highlight-video",
        help="Project slug under projects/ (default: first-highlight-video)",
    )
    parser.add_argument(
        "--kind",
        choices=sorted(KIND_TO_FORMAT),
        default="video",
        help="Import video, audio, subtitles, or metadata only (default: video)",
    )
    parser.add_argument(
        "--max-resolution",
        choices=["360p", "480p", "720p", "1080p", "1440p", "2160p", "best"],
        default="1080p",
        help="Maximum downloaded video resolution (default: 1080p)",
    )
    parser.add_argument(
        "--max-duration",
        type=int,
        default=600,
        help="Reject media longer than this many seconds (default: 600)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.max_duration <= 0:
        raise SystemExit("--max-duration must be greater than zero")

    destination = (
        project_dir(args.project)
        / "source-media"
        / "url-catalog"
        / source_id_from_url(args.url)
        / args.kind
    )

    sys.path.insert(0, str(PROJECT_ROOT))
    from tools.tool_registry import registry

    registry.ensure_discovered()
    downloader = registry.get("video_downloader")
    if downloader is None:
        raise SystemExit("video_downloader was not discovered")

    result = downloader.execute(
        {
            "url": args.url,
            "output_dir": str(destination),
            "format": KIND_TO_FORMAT[args.kind],
            "max_resolution": args.max_resolution,
            "max_duration_seconds": args.max_duration,
        }
    )
    payload = {
        "success": result.success,
        "kind": args.kind,
        "catalog_dir": str(destination),
        "data": result.data,
        "artifacts": result.artifacts,
        "error": result.error,
    }
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0 if result.success else 1


if __name__ == "__main__":
    raise SystemExit(main())
