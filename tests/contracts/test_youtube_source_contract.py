"""Regression coverage for first-class YouTube/online-media source ingest."""

from pathlib import Path

from scripts.import_media_url import build_parser
from tools.analysis.video_downloader import VideoDownloader
from tools.tool_registry import ToolRegistry


ROOT = Path(__file__).resolve().parents[2]


class _ReadyDownloader(VideoDownloader):
    dependencies = []


def test_video_downloader_declares_project_video_and_audio_ingest() -> None:
    tool = VideoDownloader()

    assert tool.capability == "source_ingest"
    assert tool.supports["project_source_ingest"] is True
    assert tool.supports["requires_user_authorization_for_production"] is True
    assert "youtube" in tool.supports["platforms"]
    assert {"video", "audio"} <= set(tool.supports["media_kinds"])


def test_provider_summary_surfaces_online_media_route() -> None:
    registry = ToolRegistry()
    registry.register(_ReadyDownloader())
    registry._discovered_packages.add("tools")

    summary = registry.provider_menu_summary()

    assert summary["source_ingest_options"] == [
        {
            "tool": "video_downloader",
            "provider": "yt-dlp",
            "platforms": [
                "youtube",
                "youtube_shorts",
                "instagram",
                "tiktok",
                "vimeo",
                "x",
                "other_yt_dlp_sites",
            ],
            "media_kinds": ["video", "audio", "subtitles", "metadata"],
            "project_source_ingest": True,
            "requires_user_authorization_for_production": True,
        }
    ]


def test_media_url_import_defaults_to_production_resolution() -> None:
    args = build_parser().parse_args(["https://youtu.be/hTWKbfoikeg"])

    assert args.kind == "video"
    assert args.max_resolution == "1080p"


def test_global_and_cinematic_guides_require_youtube_source_option() -> None:
    guide = (ROOT / "AGENT_GUIDE.md").read_text(encoding="utf-8")
    idea = (
        ROOT / "skills/pipelines/cinematic/idea-director.md"
    ).read_text(encoding="utf-8")
    proposal = (
        ROOT / "skills/pipelines/cinematic/proposal-director.md"
    ).read_text(encoding="utf-8")

    assert "YouTube / Online Media Source Entry Point" in guide
    assert 'provider_menu_summary()["source_ingest_options"]' in guide
    assert "both video and audio" in guide
    assert "User-authorized YouTube / online audio" in idea
    assert "User source ingest first" in proposal
