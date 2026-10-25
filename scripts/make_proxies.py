"""Make light preview proxies for a project's videos (editor preview only; exports use originals).

    python scripts/make_proxies.py <project> [--jobs 4]

Writes projects/<id>/proxy/<name>.mp4: <=960px wide, short GOP (fast seeking), no audio,
faststart. backlot/server.py serves these in place of public/media/<name>.* when present.
"""
import argparse, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def make(src: Path, dst: Path) -> str:
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return "skip"
    tmp = dst.with_suffix(".part.mp4")
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-an",
         "-vf", "scale='if(gt(iw,ih),960,540)':-2,fps=30",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-g", "15", "-keyint_min", "15",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(tmp)],
        capture_output=True, text=True)
    if r.returncode != 0:
        tmp.unlink(missing_ok=True)
        return f"FAIL {r.stderr.strip()[:120]}"
    tmp.replace(dst)
    return "ok"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("project")
    ap.add_argument("--jobs", type=int, default=4)
    a = ap.parse_args()
    media = ROOT / "projects" / a.project / "public" / "media"
    out = ROOT / "projects" / a.project / "proxy"
    out.mkdir(parents=True, exist_ok=True)
    vids = sorted(p for p in media.iterdir() if p.suffix.lower() in {".mp4", ".mov"})
    with ThreadPoolExecutor(a.jobs) as ex:
        res = list(ex.map(lambda p: make(p, out / (p.stem + ".mp4")), vids))
    bad = [(p.name, r) for p, r in zip(vids, res) if r.startswith("FAIL")]
    print(f"{len(vids)} videos: {res.count('ok')} made, {res.count('skip')} up to date, {len(bad)} failed")
    for n, r in bad:
        print(" ", n, r)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
