"""Make the starter sound-effects library (assets/sound_effects/*.wav) with ffmpeg. Nothing is downloaded: every sound is synthesised,
so there are no licence questions. Run again to rebuild. Add your own files to the same folder (or drop them in the editor's Sound effects folder)."""
import subprocess
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "assets" / "sound_effects"
R = "random(0)*2-1"
# name: (aevalsrc expression, seconds, optional extra audio filters)
SFX = {
    "pop": ("sin(2*PI*(300+2400*t)*t)*exp(-t*28)", 0.2, ""),
    "bubble-pop": ("sin(2*PI*(900-3000*t)*t)*exp(-t*35)", 0.18, ""),
    "ding": ("(sin(2*PI*1318*t)+0.5*sin(2*PI*2636*t)+0.25*sin(2*PI*3954*t))*exp(-t*4)*0.5", 1.2, ""),
    "notification": ("sin(2*PI*if(lt(t,0.12),880,1320)*t)*exp(-if(lt(t,0.12),t,t-0.12)*14)", 0.5, ""),
    "success-chime": ("sin(2*PI*if(lt(t,0.1),523,if(lt(t,0.2),659,if(lt(t,0.3),784,1047)))*t)*exp(-t*3)*0.8", 0.9, ""),
    "coin": ("sin(2*PI*if(lt(t,0.08),988,1319)*t)*exp(-if(lt(t,0.08),t,t-0.08)*8)", 0.6, ""),
    "click": (f"({R})*exp(-t*400)", 0.06, ""),
    "camera-shutter": (f"({R})*(exp(-t*300)+gte(t,0.07)*exp(-(t-0.07)*300))", 0.22, "lowpass=f=6000"),
    "whoosh": (f"({R})*0.6", 0.9, "lowpass=f=3500,afade=t=in:d=0.45,afade=t=out:st=0.45:d=0.45"),
    "swipe": (f"({R})*0.5", 0.3, "highpass=f=800,lowpass=f=7000,afade=t=in:d=0.1,afade=t=out:st=0.12:d=0.18"),
    "riser": (f"(0.25*sin(2*PI*(150+1800*t)*t)+0.12*({R}))*(t/2)", 2.0, "afade=t=out:st=1.9:d=0.1"),
    "impact": (f"sin(2*PI*(80-40*t)*t)*exp(-t*5)*0.9+0.3*({R})*exp(-t*40)", 1.2, "lowpass=f=1800"),
    "error-buzz": ("0.5*(gt(sin(2*PI*150*t),0)*2-1)*exp(-t*3)", 0.5, "lowpass=f=1200"),
}
OUT.mkdir(parents=True, exist_ok=True)
for name, (expr, secs, extra) in SFX.items():
    chain = ",".join(x for x in [extra, "volume=0.9", "alimiter=limit=0.95"] if x)
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"aevalsrc='{expr}':d={secs}:s=44100:c=mono", "-af", chain, "-ar", "44100", str(OUT / f"{name}.wav")]
    r = subprocess.run(cmd, capture_output=True, text=True)
    print(("ok  " if r.returncode == 0 else "FAIL"), name, r.stderr[-120:])
