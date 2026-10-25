"""Regression tests for source-review integration with analysis tool outputs."""

from types import SimpleNamespace

from lib.source_media_review import review_source_media


class _Tool:
    def __init__(self, data, *, status="available"):
        self.data = data
        self.status = status
        self.calls = []

    def get_status(self):
        return SimpleNamespace(value=self.status)

    def execute(self, inputs):
        self.calls.append(inputs)
        return SimpleNamespace(success=True, data=self.data)


class _Registry:
    def __init__(self, tools):
        self.tools = tools

    def get(self, name):
        return self.tools.get(name)


def test_video_review_collects_sampled_frame_paths_and_segment_transcript(tmp_path):
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"test")

    probe = _Tool(
        {
            "duration_seconds": 8.0,
            "resolution": "1280x720",
            "channels": 2,
        }
    )
    sampler = _Tool(
        {
            "frames": [
                {"path": "frames/frame_0000.jpg", "timestamp_seconds": 1.0},
                {"path": "frames/frame_0001.jpg", "timestamp_seconds": 5.0},
            ]
        }
    )
    transcriber = _Tool(
        {
            "segments": [
                {"start": 0.0, "end": 1.0, "text": "First sentence."},
                {"start": 1.0, "end": 2.0, "text": "Second sentence."},
            ]
        }
    )
    registry = _Registry(
        {
            "audio_probe": probe,
            "frame_sampler": sampler,
            "transcriber": transcriber,
        }
    )

    artifact = review_source_media([video], {}, registry)

    reviewed = artifact["files"][0]
    assert sampler.calls[0]["strategy"] == "timestamps"
    assert sampler.calls[0]["output_dir"].endswith(".source_review_frames/clip")
    assert reviewed["representative_frames"] == [
        "frames/frame_0000.jpg",
        "frames/frame_0001.jpg",
    ]
    assert reviewed["transcript_summary"] == "First sentence. Second sentence."
