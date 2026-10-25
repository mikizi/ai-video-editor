import copy

import jsonschema
import pytest

from lib import timeline as T


def _tl(**kw):
    tl = {
        "version": "1.0",
        "opener": None,
        "clips": [
            {"id": "a", "src": "media/a.mp4", "kind": "video", "in": 1, "out": 4, "source_duration": 10},
            {"id": "b", "src": "media/b.jpg", "kind": "image", "hold": 2, "transition": {"type": "fade", "seconds": 0.5}},
            {"id": "c", "src": "media/c.mp4", "kind": "video", "in": 0, "out": 4, "speed": 2, "transition": {"type": "cut"}},
        ],
    }
    tl.update(kw)
    return tl


def test_valid_timeline_passes():
    T.validate(_tl())


def test_unknown_field_rejected():
    tl = _tl()
    tl["clips"][0]["bogus"] = 1
    with pytest.raises(jsonschema.ValidationError):
        T.validate(tl)


def test_semantic_errors():
    tl = _tl()
    tl["clips"][1]["id"] = "a"
    with pytest.raises(T.TimelineError, match="duplicate"):
        T.validate(tl)
    tl = _tl()
    tl["clips"][0]["out"] = 0.5
    with pytest.raises(T.TimelineError, match="greater"):
        T.validate(tl)
    tl = _tl()
    tl["clips"][0]["out"] = 12
    with pytest.raises(T.TimelineError, match="past the end"):
        T.validate(tl)


def test_layout_overlaps_transitions():
    lay = T.layout(_tl())
    starts = {i["id"]: i["start"] for i in lay["items"]}
    assert starts == {"a": 0.0, "b": 2.5, "c": 4.5}
    # a=3s, b=2s, c=4s/2=2s, one 0.5s fade overlap
    assert lay["total_seconds"] == pytest.approx(6.5)


def test_first_clip_transition_only_with_opener():
    tl = _tl()
    tl["clips"][0]["transition"] = {"type": "fade", "seconds": 1}
    assert T.layout(tl)["items"][0]["start"] == 0
    tl["opener"] = {"src": "brand/o.mp4", "seconds": 4}
    lay = T.layout(tl)
    assert lay["items"][0]["start"] == pytest.approx(3.0)
    assert lay["total_seconds"] == pytest.approx(4 + 3 - 1 + 2 - 0.5 + 2)


def test_transition_capped_to_half_clip():
    tl = _tl()
    tl["clips"][1]["transition"] = {"type": "fade", "seconds": 3}
    item = T.layout(tl)["items"][1]
    assert item["transition_seconds"] == pytest.approx(1.0)  # half of the 2s image


def test_snap_to_beats_moves_clip_ends():
    tl = _tl(beats=[3.2, 5.0])
    snapped = T.snap_to_beats(tl, tolerance=0.4)
    assert snapped["clips"][0]["out"] == pytest.approx(4.2)  # end 3.0 -> beat 3.2
    assert tl["clips"][0]["out"] == 4  # original untouched
    T.validate(snapped)


def test_move_clip():
    moved = T.move_clip(_tl(), "c", 0)
    assert [c["id"] for c in moved["clips"]] == ["c", "a", "b"]


def test_save_and_load_roundtrip(tmp_path):
    p = T.save(tmp_path / "artifacts" / "timeline.json", _tl())
    assert T.load(p) == _tl()


def test_draft_from_media_images(tmp_path):
    media = tmp_path / "public" / "media"
    media.mkdir(parents=True)
    for n in ["IMG_10.jpg", "IMG_2.jpg", "notes.txt"]:
        (media / n).write_bytes(b"x")
    (tmp_path / "public" / "music").mkdir()
    (tmp_path / "public" / "music" / "song.mp3").write_bytes(b"x")
    tl = T.draft_from_media(tmp_path, aspect="16:9")
    assert [c["src"] for c in tl["clips"]] == ["media/IMG_2.jpg", "media/IMG_10.jpg"]
    assert tl["format"]["width"] == 1920
    assert tl["music"]["src"] == "music/song.mp3"
    assert tl["opener"] is None


def test_beats_to_montage_clock():
    from lib.beats import to_montage_clock
    times = [0.5, 1.0, 5.0, 9.0]
    assert to_montage_clock(times, {"offset": 0, "start_at": "clips"}, 4.0, 100) == [0.5, 1.0, 5.0, 9.0]
    assert to_montage_clock(times, {"offset": 1, "start_at": "clips"}, 4.0, 100) == [0.0, 4.0, 8.0]
    # song starts under the 4s opener: montage zero is 4s into the song
    assert to_montage_clock(times, {"offset": 0, "start_at": "opener"}, 4.0, 100) == [1.0, 5.0]
    assert to_montage_clock(times, {"offset": 0, "start_at": "clips"}, 4.0, 6) == [0.5, 1.0, 5.0]
