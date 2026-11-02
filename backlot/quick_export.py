"""Quick download: build an MP4 straight from timeline.json with ffmpeg (no Remotion).

Covers: Video 1 clips (trim, speed, volume, fit), photos (hold), subtitles/text burned in,
extra video channels (layers), music (offset, volume, fades, until).
Transitions: only "thirds" is done (the rest are hard cuts). Not covered: motion (zoom/pan), motion scenes, opener, dB keyframes.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any, Callable, Optional

FONT_FILES = ["/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial.ttf"]
SIZES = {"subtitle": 0.040, "title": 0.075, "pop": 0.085, "cine": 0.050}   # fraction of frame height
# xfade custom expression: P runs 1 -> 0 during the transition. Band k = top, middle, bottom third; each band of the new clip
# slides in (from the left for bands 0 and 2, from the right for band 1), starting 22% of the time after the one above it.
# No st()/ld() registers: ffmpeg runs the expression on several threads and they share those registers (it turns into noise).
_K = "floor(Y*3/H)"
_RAW = f"clip(((1-P)-{_K}*0.22)/0.56,0,1)"
_PK = f"({_RAW}*{_RAW}*(3-2*{_RAW}))"
_XN = f"floor(X-(2*mod({_K},2)-1)*(1-{_PK})*W)"


def _plane(fn: str, x: str) -> str:
    return f"if(eq(PLANE,0),{fn}0({x},Y),if(eq(PLANE,1),{fn}1({x},Y),{fn}2({x},Y)))"


THIRDS_EXPR = f"if(between({_XN},0,W-1),{_plane('b', _XN)},{_plane('a', 'X')})"
POS_Y = {"top": 0.12, "center": 0.5, "bottom": 0.78}


def _has_audio(path: Path) -> bool:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)],
                       capture_output=True, text=True)
    return bool(r.stdout.strip())


def _atempo(speed: float) -> str:
    parts = []
    while speed > 2.0:
        parts.append("atempo=2.0"); speed /= 2
    while speed < 0.5:
        parts.append("atempo=0.5"); speed /= 0.5
    parts.append(f"atempo={speed:.4f}")
    return ",".join(parts)


def _text_png(item: dict, w: int, h: int, out: Path) -> None:
    from PIL import Image, ImageDraw, ImageFont
    style = item.get("style") or "title"
    size = max(18, int(h * SIZES.get(style, 0.06)))
    font = None
    for f in FONT_FILES:
        try:
            font = ImageFont.truetype(f, size, index=1) if f.endswith(".ttc") else ImageFont.truetype(f, size)
            break
        except Exception:
            continue
    font = font or ImageFont.load_default()
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    maxw = int(w * 0.86)
    lines: list[str] = []
    for para in str(item["value"]).split("\n"):
        cur = ""
        for word in para.split():
            test = (cur + " " + word).strip()
            if d.textlength(test, font=font) <= maxw or not cur:
                cur = test
            else:
                lines.append(cur); cur = word
        lines.append(cur)
    lh = int(size * 1.2)
    y = int(h * POS_Y.get(item.get("position") or "center", 0.5) - lh * len(lines) / 2)
    stroke = max(2, size // 12)
    for ln in lines:
        x = (w - d.textlength(ln, font=font)) / 2
        d.text((x, y), ln, font=font, fill=(255, 255, 255, 255), stroke_width=stroke, stroke_fill=(0, 0, 0, 255))
        y += lh
    img.save(out)


def export(project_dir: Path, timeline: dict, out: Path, progress: Callable[[float, str], None], still: Optional[float] = None) -> dict[str, Any]:
    """still = seconds into the (single-clip) timeline: write one PNG frame instead of an MP4."""
    pub = project_dir / "public"
    fmt = timeline.get("format") or {}
    W, H, fps = int(fmt.get("width") or 1080), int(fmt.get("height") or 1920), int(fmt.get("fps") or 30)
    W, H = W - W % 2, H - H % 2
    clips = timeline.get("clips") or []
    if not clips:
        raise RuntimeError("the timeline has no clips")

    inputs: list[str] = []
    fc: list[str] = []
    starts: dict[str, float] = {}
    t = 0.0
    seg_v, seg_a = [], []
    seg_dur: list[float] = []
    seg_th: list[float] = []      # seconds of "thirds" overlap with the clip before (0 = plain cut)
    skipped = []
    for c in clips:
        src = pub / c["src"]
        if not src.is_file():
            skipped.append(c.get("label") or c["id"]); continue
        i = sum(1 for x in inputs if x == "-i")
        speed = float(c.get("speed") or 1)
        is_img = c.get("kind") == "image" or src.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
        if is_img:
            dur = float(c.get("hold") or 2.5)
            inputs += ["-loop", "1", "-framerate", str(fps), "-t", f"{dur:.3f}", "-i", str(src)]
            has_a = False
        else:
            cin, cout = float(c.get("in") or 0), float(c["out"])
            dur = (cout - cin) / speed
            inputs += ["-ss", f"{cin:.3f}", "-t", f"{cout - cin:.3f}", "-i", str(src)]
            has_a = _has_audio(src)
        if c.get("fit") == "contain":
            scale = f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:black"
        else:
            scale = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}"
        sp = f",setpts=(PTS-STARTPTS)/{speed}" if speed != 1 and not is_img else ",setpts=PTS-STARTPTS"
        fc.append(f"[{i}:v]{scale}{sp},fps={fps},setsar=1,format=yuv420p[v{i}]")
        vol = float(c.get("volume") if c.get("volume") is not None else 1)
        if has_a and vol > 0:
            tempo = f",{_atempo(speed)}" if speed != 1 else ""
            fc.append(f"[{i}:a]aresample=44100,aformat=channel_layouts=stereo{tempo},volume={vol:.3f},atrim=0:{dur:.3f},asetpts=PTS-STARTPTS[a{i}]")
        else:
            fc.append(f"anullsrc=r=44100:cl=stereo,atrim=0:{dur:.3f},asetpts=PTS-STARTPTS[a{i}]")
        seg_v.append(f"[v{i}]"); seg_a.append(f"[a{i}]")
        th = 0.0
        if seg_dur and (c.get("transition") or {}).get("type") == "thirds":
            th = max(0.0, min(float((c["transition"]).get("seconds") or 0.35), seg_dur[-1] / 2, dur / 2))
        seg_dur.append(dur); seg_th.append(th)
        t -= th                      # the new clip slides in over the end of the one before
        starts[c["id"]] = t
        t += dur
    if not seg_v:
        raise RuntimeError("none of the clips could be found on disk")
    total = t
    n = len(seg_v)
    # Plain cuts are joined with concat; a "thirds" boundary is an xfade with a custom expression:
    # three horizontal bands slide in one after another, alternating sides (Marvel-style).
    chunks: list[list[int]] = []
    for k in range(n):
        if k == 0 or seg_th[k] > 0:
            chunks.append([k])
        else:
            chunks[-1].append(k)
    for j, ch in enumerate(chunks):
        fc.append("".join(f"{seg_v[k]}{seg_a[k]}" for k in ch) + f"concat=n={len(ch)}:v=1:a=1[cv{j}][ca{j}]")
    acc_v, acc_a, acc_dur = "[cv0]", "[ca0]", sum(seg_dur[k] for k in chunks[0])
    for j in range(1, len(chunks)):
        d = seg_th[chunks[j][0]]
        cdur = sum(seg_dur[k] for k in chunks[j])
        fc.append(f"{acc_v}[cv{j}]xfade=transition=custom:duration={d:.3f}:offset={acc_dur - d:.3f}:expr='{THIRDS_EXPR}'[xv{j}]")
        fc.append(f"{acc_a}[ca{j}]acrossfade=d={d:.3f}[xa{j}]")
        acc_v, acc_a, acc_dur = f"[xv{j}]", f"[xa{j}]", acc_dur + cdur - d
    if len(chunks) == 1:
        fc.append("[cv0]null[vm]"); fc.append("[ca0]anull[am]")
    else:
        fc.append(f"{acc_v}null[vm]"); fc.append(f"{acc_a}anull[am]")
    cur_v, cur_a = "[vm]", "[am]"
    mix_audio = [cur_a]

    def add_input(args: list[str]) -> int:
        idx = sum(1 for x in inputs if x == "-i")
        inputs.extend(args)
        return idx

    # extra video channels
    for k, ly in enumerate(timeline.get("layers") or []):
        src = pub / ly["src"]
        if not src.is_file():
            continue
        s, e = float(ly["start"]), min(float(ly["end"]), total)
        if e <= s:
            continue
        sp = float(ly.get("speed") or 1)
        if ly.get("kind") == "image":
            i = add_input(["-loop", "1", "-framerate", str(fps), "-t", f"{e - s:.3f}", "-i", str(src)])
        else:
            i = add_input(["-ss", f"{float(ly.get('in') or 0):.3f}", "-t", f"{(e - s) * sp:.3f}", "-i", str(src)])
        lw = float(ly.get("width") or 1)
        fit = (f"scale={W}:{H}:force_original_aspect_ratio=decrease" if ly.get("fit") == "contain" or lw < 1
               else f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}")
        if lw < 1:
            fit = f"scale={int(W * lw)}:-2"
        ox = f"(W-w)*{float(ly.get('x', 0.5)):.3f}"
        oy = f"(H-h)*{float(ly.get('y', 0.5)):.3f}"
        tf = ly.get("transform")
        if tf:   # same as the editor: fit the picture in the frame, scale it, then move its centre by x/y (fractions of the frame)
            sc = float(tf.get("scale", 1))
            pop = float(ly.get("pop") or 0)
            if pop:   # grows from zero with a bounce (same damped spring as the preview); t is the time since the layer started, because this runs before the layer is shifted to its place
                pp = f"clip(t/{pop:.3f},0,1)"
                kx = f"if(lt({pp},1),1-exp(-5*{pp})*cos(9*{pp}),1)"
                fit = (f"scale={W}:{H}:force_original_aspect_ratio=decrease,"
                       f"scale=w='max(2,trunc(iw*{sc:.4f}*({kx})/2)*2)':h='max(2,trunc(ih*{sc:.4f}*({kx})/2)*2)':eval=frame")
            else:
                fit = f"scale={W}:{H}:force_original_aspect_ratio=decrease,scale=trunc(iw*{sc:.4f}/2)*2:trunc(ih*{sc:.4f}/2)*2"
            ox = f"(W-w)/2+W*{float(tf.get('x', 0)):.4f}"
            oy = f"(H-h)/2+H*{float(tf.get('y', 0)):.4f}"
        sp_f = f",setpts=(PTS-STARTPTS)/{sp}" if sp != 1 else ",setpts=PTS-STARTPTS"
        fc.append(f"[{i}:v]{fit}{sp_f}+{s:.3f}/TB,format=yuva420p[ly{k}]")
        fc.append(f"{cur_v}[ly{k}]overlay={ox}:{oy}:eof_action=pass:enable='between(t,{s:.3f},{e:.3f})'[vl{k}]")
        cur_v = f"[vl{k}]"
        if ly.get("kind") == "video" and float(ly.get("volume") if ly.get("volume") is not None else 1) > 0 and _has_audio(src):
            tempo = f",{_atempo(sp)}" if sp != 1 else ""
            fc.append(f"[{i}:a]aresample=44100,aformat=channel_layouts=stereo{tempo},volume={float(ly.get('volume', 1)):.3f},adelay={int(s * 1000)}|{int(s * 1000)}[la{k}]")
            mix_audio.append(f"[la{k}]")

    # text and subtitles, burned in
    tmp = out.parent / f".{out.stem}-text"
    tmp.mkdir(exist_ok=True)
    pngs = []
    try:
        for k, tx in enumerate(timeline.get("texts") or []):
            if not str(tx.get("value") or "").strip():
                continue
            base = starts.get(tx.get("follow") or "", 0.0) if tx.get("follow") else 0.0
            if tx.get("follow") and tx["follow"] not in starts:
                continue
            s, e = base + float(tx["start"]), min(base + float(tx["end"]), total)
            if e <= s:
                continue
            png = tmp / f"t{k}.png"
            _text_png(tx, W, H, png)
            i = add_input(["-loop", "1", "-framerate", "1", "-t", f"{total:.3f}", "-i", str(png)])
            fc.append(f"{cur_v}[{i}:v]overlay=0:0:enable='between(t,{s:.3f},{e:.3f})'[vt{k}]")
            cur_v = f"[vt{k}]"
            pngs.append(png)

        # music
        pieces = []
        m = timeline.get("music")
        if m:
            pieces.append(m)
        pieces += timeline.get("music_more") or []
        for k, mu in enumerate(pieces):
            src = pub / mu["src"]
            if not src.is_file():
                continue
            until = min(float(mu.get("until") or total), total)
            ms = float(mu.get("start") or 0) if "start" in mu else 0.0
            span = max(0.5, until - ms)
            i = add_input(["-ss", f"{float(mu.get('offset') or 0):.3f}", "-t", f"{span:.3f}", "-i", str(src)])
            fo = min(float(mu.get("fade_out", 2.0)), span)
            fi = float(mu.get("fade_in", 0.5))
            fc.append(f"[{i}:a]aresample=44100,aformat=channel_layouts=stereo,volume={float(mu.get('volume', 0.8)):.3f},"
                      f"afade=t=in:d={fi:.2f},afade=t=out:st={max(0, span - fo):.2f}:d={fo:.2f},adelay={int(ms * 1000)}|{int(ms * 1000)}[mu{k}]")
            mix_audio.append(f"[mu{k}]")

        if len(mix_audio) > 1:
            fc.append("".join(mix_audio) + f"amix=inputs={len(mix_audio)}:normalize=0:duration=first,alimiter=limit=0.95[aout]")
            amap = "[aout]"
        else:
            amap = cur_a
        fc.append(f"{cur_v}null[vout]")

        if still is not None:
            fc.append(f"{amap}anullsink")
            cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *inputs,
                   "-filter_complex", ";\n".join(fc), "-map", "[vout]", "-ss", f"{min(max(still, 0), max(total - 0.05, 0)):.3f}",
                   "-frames:v", "1", str(out)]
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0 or not out.is_file():
                raise RuntimeError(r.stderr[-1500:] or "ffmpeg failed")
            return {}
        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats", *inputs,
               "-filter_complex", ";\n".join(fc), "-map", "[vout]", "-map", amap, "-t", f"{total:.3f}",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
               "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)]
        progress(0.02, "encoding")
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for line in p.stdout:  # type: ignore[union-attr]
            mt = re.match(r"out_time_ms=(\d+)", line)
            if mt:
                progress(min(0.99, int(mt.group(1)) / 1e6 / total), "encoding")
        err = p.stderr.read() if p.stderr else ""
        if p.wait() != 0:
            raise RuntimeError(err[-1500:] or "ffmpeg failed")
    finally:
        for f in tmp.glob("*"):
            f.unlink(missing_ok=True)
        tmp.rmdir()
    return {"seconds": round(total, 2), "skipped": skipped,
            "left_out": [x for x, on in (("transitions", any((c.get("transition") or {}).get("type") not in (None, "cut", "thirds") for c in clips)),
                                         ("zoom/pan motion", any(c.get("motion") not in (None, "none") for c in clips)),
                                         ("opener", bool(timeline.get("opener")))) if on]}
