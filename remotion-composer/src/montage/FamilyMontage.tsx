// FamilyMontage — one reusable, data-driven montage composition.
// Everything on screen comes from `props.timeline` (artifacts/timeline.json).
// Media paths are relative to the project's public/ dir (render with --public-dir).
import React from "react";
import {
  AbsoluteFill, CalculateMetadataFunction, Easing, Img, interpolate,
  OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig,
} from "remotion";
import { Audio } from "@remotion/media";
import { loadFont as loadHeebo } from "@remotion/google-fonts/Heebo";
import { loadFont as loadRubik } from "@remotion/google-fonts/Rubik";
import { loadFont as loadAssistant } from "@remotion/google-fonts/Assistant";
import { loadFont as loadAnton } from "@remotion/google-fonts/Anton";
import { loadFont as loadMontserrat } from "@remotion/google-fonts/Montserrat";
import { layoutTimeline, textWindow, LaidOut } from "./layout";
import type { Overlay, Pip, Clip, FamilyMontageProps, TextItem, TextPosition, TextStyle, Timeline, TransitionType } from "./types";

// Fonts load lazily: only the font the timeline uses is downloaded.
const FONT_LOADERS: Record<string, () => string> = {
  Heebo: () => loadHeebo("normal", { weights: ["200", "300", "500", "800"], subsets: ["hebrew", "latin"] }).fontFamily,
  Rubik: () => loadRubik("normal", { weights: ["500", "800"], subsets: ["hebrew", "latin"] }).fontFamily,
  Assistant: () => loadAssistant("normal", { weights: ["600", "800"], subsets: ["hebrew", "latin"] }).fontFamily,
  Anton: () => loadAnton("normal", { weights: ["400"], subsets: ["latin"] }).fontFamily,
  Montserrat: () => loadMontserrat("normal", { weights: ["600", "900"], subsets: ["latin"] }).fontFamily,
};
const fontCache: Record<string, string> = {};
const getFont = (name: string): string => {
  const key = FONT_LOADERS[name] ? name : "Heebo";
  if (!fontCache[key]) fontCache[key] = FONT_LOADERS[key]();
  return fontCache[key];
};

const GRADES: Record<string, string> = {
  none: "none",
  warm: "saturate(1.15) contrast(1.06) sepia(0.12) brightness(1.02)",
  cool: "saturate(1.05) contrast(1.06) hue-rotate(-8deg)",
  vivid: "saturate(1.35) contrast(1.1)",
  film: "contrast(1.1) saturate(0.9) sepia(0.2)",
  bw: "grayscale(1) contrast(1.15)",
};

const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };
const ease = Easing.inOut(Easing.cubic);
const isRtl = (s: string) => /[֐-׿؀-ۿ]/.test(s);
// mediaBase: when set (editor live preview), media is loaded from that URL
// prefix instead of the Remotion public dir.
const MediaBase = React.createContext<string | undefined>(undefined);
const resolveSrc = (p: string, base?: string) =>
  /^(https?:|data:|blob:)/.test(p) ? p : base ? base + p.split("/").map(encodeURIComponent).join("/") : staticFile(p);
const useSrc = () => {
  const base = React.useContext(MediaBase);
  return (p: string) => resolveSrc(p, base);
};

// ---------------------------------------------------------------------------
// Transitions: style for the incoming (enter) and outgoing (exit) item.
// p goes 0 -> 1 across the overlap.
// ---------------------------------------------------------------------------
interface Fx { opacity: number; transform: string; filter: string; flash: number; bracket?: number; clipPath?: string; glitch?: number; leak?: number; leakX?: number }
const NONE: Fx = { opacity: 1, transform: "", filter: "", flash: 0 };

const rnd = (n: number) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

// Camera shutter: hard cut + bright flash that decays fast, a viewfinder frame, and a punch-in settle.
function shutterFx(p: number): Fx {
  const e = ease(Math.min(1, p));
  return { ...NONE, flash: 0, transform: `scale(${1 + 0.16 * (1 - e)})`, bracket: p < 0.75 ? 1 - p / 0.75 : 0 };
}

function enterFx(type: TransitionType, p: number, tr?: Transition, vw = 1920, vh = 1080): Fx {
  const e = ease(p);
  switch (type) {
    case "fade": return { ...NONE, opacity: e };
    case "flash": return { ...NONE, opacity: p >= 0.5 ? 1 : 0, flash: 0.55 * (1 - Math.abs(2 * p - 1)) };
    case "zoom": return { ...NONE, opacity: Math.min(1, p * 2), transform: `scale(${1.3 - 0.3 * e})` };
    case "slide-left": return { ...NONE, transform: `translateX(${(1 - e) * 100}%)` };
    case "slide-up": return { ...NONE, transform: `translateY(${(1 - e) * 100}%)` };
    case "whip": return { ...NONE, transform: `translateX(${(1 - e) * 100}%)`, filter: `blur(${(1 - Math.abs(2 * p - 1)) * 24}px)` };
    case "dip-black": return { ...NONE, opacity: Math.max(0, 2 * p - 1) };
    case "whip-right": return { ...NONE, transform: `translateX(${-(1 - e) * 100}%)`, filter: `blur(${(1 - Math.abs(2 * p - 1)) * 24}px)` };
    case "whip-up": return { ...NONE, transform: `translateY(${(1 - e) * 100}%)`, filter: `blur(${(1 - Math.abs(2 * p - 1)) * 24}px)` };
    case "zoom-through": return { ...NONE, opacity: Math.min(1, p * 2.2), transform: `scale(${0.55 + 0.45 * e})`, filter: `blur(${(1 - e) * 14}px)` };
    case "spin": return { ...NONE, opacity: Math.min(1, p * 2), transform: `rotate(${-(1 - e) * 28}deg) scale(${0.55 + 0.45 * e})`, filter: `blur(${(1 - e) * 12}px)` };
    case "flip": return { ...NONE, opacity: p < 0.5 ? 0 : 1, transform: `perspective(1400px) rotateY(${-90 + 90 * e}deg) scale(${0.85 + 0.15 * e})` };
    case "iris": return { ...NONE, clipPath: `circle(${e * 78}% at 50% 50%)`, transform: `scale(${1.15 - 0.15 * e})` };
    case "wipe-diag": { const x = -25 + 150 * e; return { ...NONE, clipPath: `polygon(0 0, ${x}% 0, ${x - 25}% 100%, 0 100%)`, transform: `scale(${1.08 - 0.08 * e})` }; }
    case "glitch": { const q = Math.floor(p * 14); return { ...NONE, glitch: Math.pow(1 - p, 1.3), transform: `translate(${(rnd(q) - 0.5) * 70 * (1 - p)}px, ${(rnd(q + 9) - 0.5) * 16 * (1 - p)}px) scale(${1 + 0.06 * (1 - p)})`, flash: 0.18 * (rnd(q + 3) > 0.7 ? 1 - p : 0) }; }
    case "blur-dissolve": return { ...NONE, opacity: e, filter: `blur(${(1 - Math.abs(2 * p - 1)) * 22}px)` };
    case "light-leak": return { ...NONE, opacity: Math.min(1, p * 2.4), leak: 1 - Math.abs(2 * p - 1), leakX: p };
    case "window": {
      // Go THROUGH the card: it starts exactly as the small 9:16 card, then the camera rushes in (slow start, fast finish,
      // a touch of motion blur) until the card is the whole frame, so it feels like stepping into the shot.
      const q = Math.pow(p, 2.2), w = (tr?.width ?? 0.22) * vw, h = w * 16 / 9, s0 = Math.min(1, h / vh);
      const tx = ((tr?.x ?? 0.2) * vw - vw / 2) * (1 - q), ty = ((tr?.y ?? 0.5) * vh - vh / 2) * (1 - q);
      const side = Math.max(0, (1 - (vh * 9 / 16) / vw) / 2 * 100) * (1 - q), r = 22 * (1 - q);
      return { ...NONE, transform: `translate(${tx}px, ${ty}px) scale(${s0 + (1 - s0) * q})`, filter: `blur(${Math.sin(Math.PI * p) * 5}px)`, clipPath: `inset(0% ${side}% 0% ${side}% round ${r}px)` };
    }
    case "tunnel": {   // incoming half of the dive: the new shot swells in from slightly too close, fading up once the old card has swallowed the frame
      const o = Math.max(0, Math.min(1, (p - 0.4) / 0.5)), k = 1.55 - 0.55 * ease(p);
      return { ...NONE, opacity: o * o * (3 - 2 * o), transform: `scale(${k})`, filter: `blur(${(1 - e) * 9}px)` };
    }
    case "reveal-up": return { ...NONE, clipPath: `inset(${(1 - e) * 100}% 0% 0% 0%)`, transform: `translateY(${(1 - e) * 6}%) scale(${1.1 - 0.1 * e})` };
    case "shake": { const q = Math.floor(p * 18); const d = 1 - p; return { ...NONE, transform: `translate(${(rnd(q) - 0.5) * 90 * d}px, ${(rnd(q + 5) - 0.5) * 60 * d}px) rotate(${(rnd(q + 11) - 0.5) * 5 * d}deg) scale(${1 + 0.22 * d})`, flash: 0.35 * d * d }; }
    default: return NONE;
  }
}

function exitFx(type: TransitionType, p: number, tr?: Transition, vw = 1920, vh = 1080): Fx {
  const e = ease(p);
  switch (type) {
    case "tunnel": {   // outgoing half: dive INTO the pip card (centre = the card), accelerating, so the card grows past the screen edges
      const cx = (tr?.x ?? 0.2) * vw - vw / 2, cy = (tr?.y ?? 0.5) * vh - vh / 2, k = 1 + 7 * Math.pow(p, 2.6);
      return { ...NONE, transform: `translate(${cx}px, ${cy}px) scale(${k}) translate(${-cx}px, ${-cy}px)`, filter: `blur(${Math.pow(p, 1.6) * 7}px)` };
    }
    case "zoom": return { ...NONE, transform: `scale(${1 + 0.3 * e})`, opacity: 1 - e };
    case "slide-left": return { ...NONE, transform: `translateX(${-e * 100}%)` };
    case "slide-up": return { ...NONE, transform: `translateY(${-e * 100}%)` };
    case "whip": return { ...NONE, transform: `translateX(${-e * 100}%)`, filter: `blur(${(1 - Math.abs(2 * p - 1)) * 24}px)` };
    case "dip-black": return { ...NONE, opacity: Math.max(0, 1 - 2 * p) };
    case "whip-right": return { ...NONE, transform: `translateX(${e * 100}%)`, filter: `blur(${(1 - Math.abs(2 * p - 1)) * 24}px)` };
    case "whip-up": return { ...NONE, transform: `translateY(${-e * 100}%)`, filter: `blur(${(1 - Math.abs(2 * p - 1)) * 24}px)` };
    case "zoom-through": return { ...NONE, opacity: Math.max(0, 1 - p * 1.3), transform: `scale(${1 + 1.4 * e})`, filter: `blur(${e * 14}px)` };
    case "spin": return { ...NONE, opacity: Math.max(0, 1 - p * 1.4), transform: `rotate(${e * 28}deg) scale(${1 + 0.5 * e})`, filter: `blur(${e * 12}px)` };
    case "flip": return { ...NONE, opacity: p > 0.5 ? 0 : 1, transform: `perspective(1400px) rotateY(${e * 90}deg) scale(${1 - 0.15 * e})` };
    case "blur-dissolve": return { ...NONE, opacity: 1 - e, filter: `blur(${(1 - Math.abs(2 * p - 1)) * 22}px)` };
    case "light-leak": return { ...NONE, opacity: Math.max(0, 1 - p * 1.3) };
    case "glitch": { const q = Math.floor(p * 14); return { ...NONE, glitch: Math.pow(p, 1.3), transform: `translate(${(rnd(q + 40) - 0.5) * 70 * p}px, 0)` }; }
    default: return NONE; // fade/flash/iris/wipe-diag/shake: incoming layer covers the outgoing one
  }
}

// Ken-Burns style motion across the clip; m goes 0 -> 1.
function motionTransform(motion: Clip["motion"], m: number, localFrame: number, fps: number): string {
  switch (motion) {
    case "zoom-in": return `scale(${1 + 0.12 * m})`;
    case "zoom-out": return `scale(${1.12 - 0.12 * m})`;
    case "pan-left": return `scale(1.12) translateX(${4 - 8 * m}%)`;
    case "pan-right": return `scale(1.12) translateX(${-4 + 8 * m}%)`;
    case "punch": {
      const s = spring({ frame: localFrame, fps, config: { damping: 14, stiffness: 220 } });
      return `scale(${1.14 - 0.14 * s + 0.04 * m})`;
    }
    default: return "";
  }
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------
const Media: React.FC<{ clip: Clip; fit: "cover" | "contain"; muted: boolean; blur?: boolean }> = ({ clip, fit, muted, blur }) => {
  const { fps, width: vw, height: vh } = useVideoConfig();
  const src = useSrc();
  const fx = clip.focus?.x ?? 0.5;
  const fy = clip.focus?.y ?? 0.5;
  const rot = ((clip.rotate ?? 0) % 360 + 360) % 360;
  const style: React.CSSProperties = {
    width: "100%", height: "100%", objectFit: fit,
    objectPosition: `${fx * 100}% ${fy * 100}%`,
    ...(blur ? { filter: "blur(40px) brightness(0.7)", transform: "scale(1.15)" } : {}),
  };
  if (rot) {
    // Rotate about the centre; for 90/270 swap the box so the rotated picture still fills the frame.
    const swap = rot === 90 || rot === 270;
    style.position = "absolute";
    style.left = "50%"; style.top = "50%";
    style.width = swap ? vh : vw; style.height = swap ? vw : vh;
    style.transform = `translate(-50%, -50%) rotate(${rot}deg)${blur ? " scale(1.15)" : ""}`;
  }
  if (clip.kind === "image") return <Img src={src(clip.src)} style={style} />;
  return (
    <OffthreadVideo
      src={src(clip.src)}
      trimBefore={Math.round((clip.in ?? 0) * fps)}
      playbackRate={clip.speed || 1}
      volume={muted ? 0 : clip.volume ?? 0}
      muted={muted || !(clip.volume ?? 0)}
      pauseWhenBuffering={false}
      style={style}
    />
  );
};

// Picture-in-picture "photo card": a second shot that pops in on top of the clip, tilted like a snapshot.
const PipCard: React.FC<{ pip: Pip; durF: number; hold?: boolean }> = ({ pip, durF, hold }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const src = useSrc();
  const delayF = Math.round((pip.delay ?? 0.25) * fps);
  const f = frame - delayF;
  if (f < 0) return null;
  const w = (pip.width ?? 0.24) * width;
  const h = w * 16 / 9;                                  // the card shows a vertical (9:16) shot
  const s = spring({ frame: f, fps, config: { damping: 13, stiffness: 150 } });
  const out = hold ? 1 : interpolate(frame, [durF - 8, durF], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const cx = (pip.x ?? 0.78) * width, cy = (pip.y ?? 0.5) * height;
  const rot = (pip.rotate ?? 3) + (1 - s) * 10;
  const border = Math.max(6, w * 0.035);
  return (
    <div style={{ position: "absolute", left: cx - w / 2, top: cy - h / 2, width: w, height: h, opacity: Math.min(1, s * 1.6) * out,
      transform: `translateX(${(1 - s) * 220}px) rotate(${rot}deg) scale(${0.7 + 0.3 * s})`,
      borderRadius: border * 1.4, border: `${border}px solid #fff`, boxShadow: "0 18px 50px rgba(0,0,0,.55)", overflow: "hidden", background: "#000" }}>
      <OffthreadVideo src={src(pip.src)} trimBefore={Math.round((pip.in ?? 0) * fps)} playbackRate={pip.speed || 1} muted volume={0}
        pauseWhenBuffering={false} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    </div>
  );
};

// Overlay card: a small video (e.g. a mini route map) on top of the whole edit for a time range.
const OverlayCard: React.FC<{ o: Overlay; durF: number; filter?: string }> = ({ o, durF, filter }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const src = useSrc();
  const s = spring({ frame, fps, config: { damping: 14, stiffness: 140 } });
  const out = interpolate(frame, [durF - 10, durF], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const w = (o.width ?? 0.3) * width, h = w * (o.aspect ?? 0.5625);
  if (o.flat) {                                   // split-screen column: edge to edge, no frame, hard cut in and out (no fades = no flicker)
    const cxf = (o.x ?? 0.5) * width, cyf = (o.y ?? 0.5) * height;
    const rv = o.reveal ? Math.max(1, Math.round((o.reveal_seconds ?? 0.7) * fps)) : 0;         // "reveal": wipes up from the bottom edge
    const e = rv ? interpolate(frame, [0, rv], [0, 1], { extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) }) : 1;
    const exF = o.exit ? Math.max(1, Math.round((o.exit_seconds ?? 0.8) * fps)) : 0;                // "exit": slide out at the end (up or down)
    const xe = exF ? interpolate(frame, [durF - exF, durF], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) }) : 0;
    const exitY = o.exit === "up" ? -xe * 100 : xe * 100;
    return (
      <div style={{ position: "absolute", left: cxf - w / 2, top: cyf - h / 2, width: w, height: h, overflow: "hidden", background: "#000", filter: o.reveal ? filter : undefined,
        clipPath: rv ? (o.reveal_from === "top" ? `inset(0% 0% ${(1 - e) * 100}% 0%)` : `inset(${(1 - e) * 100}% 0% 0% 0%)`) : undefined,
        transform: [rv ? `translateY(${(o.reveal_from === "top" ? -1 : 1) * (1 - e) * 5}%)` : "", exF ? `translateY(${exitY}%)` : ""].filter(Boolean).join(" ") || undefined }}>
        <OffthreadVideo src={src(o.src)} trimBefore={Math.round((o.in ?? 0) * fps)} playbackRate={o.speed || 1} muted volume={0} pauseWhenBuffering={false} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    );
  }
  const cx = (o.x ?? 0.82) * width, cy = (o.y ?? 0.5) * height, border = Math.max(6, w * 0.02);
  return (
    <div style={{ position: "absolute", left: cx - w / 2, top: cy - h / 2, width: w, height: h, opacity: Math.min(1, s * 1.5) * out,
      transform: `translateX(${(1 - s) * 160}px) rotate(${(o.rotate ?? 0) + (1 - s) * 6}deg) scale(${0.75 + 0.25 * s})`,
      borderRadius: border * 1.6, border: `${border}px solid #fff`, boxShadow: "0 18px 50px rgba(0,0,0,.55)", overflow: "hidden", background: "#000" }}>
      <OffthreadVideo src={src(o.src)} trimBefore={Math.round((o.in ?? 0) * fps)} muted volume={0} pauseWhenBuffering={false} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    </div>
  );
};

const ClipLayer: React.FC<{ item: LaidOut; startFrame: number; beatFrames: number[]; pulse: number }> = ({ item, startFrame, beatFrames, pulse }) => {
  const frame = useCurrentFrame();
  const { fps, width: vw, height: vh } = useVideoConfig();
  const durF = Math.round(item.duration * fps);
  const inF = Math.round(item.transIn * fps);
  const outF = Math.round(item.transOut * fps);
  const { clip } = item;

  let fx: Fx = NONE;
  const shutterF = !item.isOpener && clip.transition?.type === "shutter" ? Math.max(2, Math.round((clip.transition.seconds ?? 0.3) * fps)) : 0;
  if (shutterF > 0 && frame < shutterF) fx = shutterFx(frame / shutterF);
  else if (inF > 0 && frame < inF) fx = enterFx(item.transInType, frame / inF, clip.transition, vw, vh);
  else if (outF > 0 && frame >= durF - outF) fx = exitFx(item.transOutType, (frame - (durF - outF)) / outF, item.transOutTr, vw, vh);

  // Beat pulse: small scale bump that decays after each beat.
  let bump = 0;
  if (pulse > 0 && beatFrames.length) {
    const g = startFrame + frame;
    let last = -1;
    for (const b of beatFrames) { if (b <= g) last = b; else break; }
    if (last >= 0) bump = pulse * Math.exp(-(g - last) / 4);
  }

  const m = durF > 1 ? frame / (durF - 1) : 0;
  const motion = motionTransform(clip.motion, Math.min(1, Math.max(0, m)), frame, fps);
  const fit = clip.fit ?? "cover";
  const body = (
    <AbsoluteFill style={{ transform: `${motion} scale(${1 + bump})` }}>
      <AbsoluteFill style={{ transform: clip.zoom && clip.zoom > 1 ? `scale(${clip.zoom})` : undefined, transformOrigin: `${(clip.focus?.x ?? 0.5) * 100}% ${(clip.focus?.y ?? 0.5) * 100}%` }}>
        {fit === "blur-fill" ? (
          <>
            <Media clip={clip} fit="cover" muted blur />
            <AbsoluteFill><Media clip={clip} fit="contain" muted={false} /></AbsoluteFill>
          </>
        ) : (
          <Media clip={clip} fit={fit} muted={false} />
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
  const g = fx.glitch ?? 0;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ opacity: fx.opacity, transform: fx.transform, filter: fx.filter || undefined, clipPath: fx.clipPath, overflow: "hidden", backgroundColor: g > 0 ? "#000" : undefined }}>
        {g > 0 ? (
          <>
            {/* RGB split: the picture three times, one colour channel each, nudged apart */}
            <AbsoluteFill style={{ mixBlendMode: "screen", filter: "url(#mt-r)", transform: `translateX(${-g * 34}px)` }}>{body}</AbsoluteFill>
            <AbsoluteFill style={{ mixBlendMode: "screen", filter: "url(#mt-g)", transform: `translateX(${g * 6}px)` }}>{body}</AbsoluteFill>
            <AbsoluteFill style={{ mixBlendMode: "screen", filter: "url(#mt-b)", transform: `translateX(${g * 34}px)` }}>{body}</AbsoluteFill>
          </>
        ) : body}
        {clip.pip && !item.isOpener && <PipCard pip={clip.pip} durF={durF} hold={item.transOutType === "tunnel"} />}
      </AbsoluteFill>
      {(fx.leak ?? 0) > 0 && (
        <AbsoluteFill style={{ mixBlendMode: "screen", opacity: Math.min(1, (fx.leak ?? 0) * 1.1), pointerEvents: "none",
          background: "linear-gradient(105deg, rgba(255,90,20,0) 5%, rgba(255,140,40,.95) 35%, rgba(255,60,110,.85) 55%, rgba(255,210,90,.6) 75%, rgba(255,120,40,0) 95%)",
          transform: `translateX(${((fx.leakX ?? 0.5) - 0.5) * 60}%) scale(1.4)` }} />
      )}
      {fx.flash > 0 && <AbsoluteFill style={{ backgroundColor: "white", opacity: fx.flash }} />}
      {(fx.bracket ?? 0) > 0 && (
        <AbsoluteFill style={{ pointerEvents: "none", opacity: fx.bracket }}>
          {[[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y], i) => (
            <div key={i} style={{ position: "absolute", [x ? "right" : "left"]: "6%", [y ? "bottom" : "top"]: "9%", width: "5%", height: "9%",
              borderColor: "rgba(255,255,255,.95)", borderStyle: "solid", borderWidth: 0,
              [x ? "borderRightWidth" : "borderLeftWidth"]: 5, [y ? "borderBottomWidth" : "borderTopWidth"]: 5 }} />
          ))}
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------
const TextOverlay: React.FC<{ value: string; position: TextPosition; kind: TextStyle; durF: number; font: string; accent: string }> = ({ value, position, kind, durF, font, accent }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const rtl = isRtl(value);
  const unit = Math.min(width, height);
  const fadeOut = interpolate(frame, [durF - 8, durF], [1, 0], clamp);
  const justify = position === "top" ? "flex-start" : position === "bottom" ? "flex-end" : "center";
  const pad = position === "center" ? 0 : height * 0.12;

  let body: React.ReactNode;
  if (kind === "subtitle") {
    const s = spring({ frame, fps, config: { damping: 20, stiffness: 200 } });
    body = (
      <div style={{ background: "rgba(0,0,0,.62)", color: "white", padding: `${unit * 0.018}px ${unit * 0.035}px`, borderRadius: unit * 0.02,
        fontSize: unit * 0.05, fontWeight: 500, transform: `translateY(${(1 - s) * 30}px)`, opacity: s }}>{value}</div>
    );
  } else if (kind === "cine") {
    // Cinematic title: big thin letter-spaced line + small wide subtitle, drifts in slowly (aerial-intro look).
    // "\n" splits the main line from the subtitle.
    const [main, ...rest] = value.split("\n");
    const sub = rest.join(" ");
    const inP = spring({ frame, fps, config: { damping: 30, stiffness: 40, mass: 1.4 } });
    const subP = spring({ frame: frame - 10, fps, config: { damping: 30, stiffness: 50 } });
    const track = 0.34 - 0.2 * inP;
    // One fixed size that fits on ONE line even at the widest letter-spacing, so the title never re-wraps while it animates in.
    const mainSize = Math.min(unit * 0.16, (width * 0.9) / (Math.max(4, [...main].length) * 1.0));
    body = (
      <div style={{ textAlign: "center", maxWidth: "92%", color: "white", textShadow: "0 4px 40px rgba(0,0,0,.45)", transform: `translateY(${(1 - inP) * 18}px)` }}>
        <div style={{ fontSize: mainSize, whiteSpace: "nowrap", fontWeight: 500, letterSpacing: `${track}em`, paddingInlineStart: `${track}em`, lineHeight: 1.05, textTransform: "uppercase", opacity: inP, textShadow: "0 3px 16px rgba(0,0,0,.9), 0 0 4px rgba(0,0,0,.7)" }}>{main}</div>
        {sub ? <div style={{ whiteSpace: "nowrap", marginTop: unit * 0.03, fontSize: unit * 0.05, fontWeight: 500, letterSpacing: "0.26em", textShadow: "0 2px 14px rgba(0,0,0,.9), 0 0 4px rgba(0,0,0,.7)", paddingInlineStart: "0.26em", textTransform: "uppercase", opacity: Math.max(0, subP) }}>{sub}</div> : null}
        <div style={{ height: unit * 0.011, width: `${inP * 22}%`, background: accent, margin: `${unit * 0.026}px auto 0`, borderRadius: 99, boxShadow: "0 2px 10px rgba(0,0,0,.5)" }} />
      </div>
    );
  } else if (kind === "title") {
    const s = spring({ frame, fps, config: { damping: 12, stiffness: 120 } });
    const bar = interpolate(frame, [6, 22], [0, 1], { ...clamp, easing: ease });
    body = (
      <div style={{ textAlign: "center", maxWidth: "86%", transform: `scale(${0.85 + 0.15 * s})`, opacity: s }}>
        <div style={{ color: "white", fontSize: unit * 0.085, fontWeight: 800, lineHeight: 1.08, textShadow: "0 6px 30px rgba(0,0,0,.55)" }}>{value}</div>
        <div style={{ height: unit * 0.012, width: `${bar * 60}%`, background: accent, margin: `${unit * 0.025}px auto 0`, borderRadius: 99 }} />
      </div>
    );
  } else {
    // "pop": CapCut-style word-by-word pop with thick outline; last word in accent.
    const words = value.split(/\s+/).filter(Boolean);
    body = (
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: `0 ${unit * 0.022}px`, maxWidth: "88%" }}>
        {words.map((w, i) => {
          const s = spring({ frame: frame - i * 3, fps, config: { damping: 9, stiffness: 260 } });
          return (
            <span key={i} style={{
              display: "inline-block", fontSize: unit * 0.085, fontWeight: 800, lineHeight: 1.15,
              color: i === words.length - 1 ? accent : "white",
              WebkitTextStroke: `${unit * 0.008}px black`, paintOrder: "stroke fill",
              textShadow: "0 8px 0 rgba(0,0,0,.35)",
              transform: `scale(${Math.max(0, s)})`, opacity: Math.min(1, s * 1.5),
            }}>{w}</span>
          );
        })}
      </div>
    );
  }
  const scrim = kind === "cine" && position !== "center";
  const scrimIn = Math.min(1, frame / 10);
  return (
    <AbsoluteFill style={{ justifyContent: justify, alignItems: "center", padding: `${pad}px 0`, direction: rtl ? "rtl" : "ltr", fontFamily: font, opacity: fadeOut }}>
      {scrim && <div style={{ position: "absolute", left: 0, right: 0, [position]: 0, height: "46%", opacity: scrimIn,
        background: `linear-gradient(to ${position === "top" ? "bottom" : "top"}, rgba(0,0,0,.66) 0%, rgba(0,0,0,.34) 55%, rgba(0,0,0,0) 100%)` }} />}
      {body}
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------
export const FamilyMontage: React.FC<FamilyMontageProps> = ({ timeline, mediaBase }) => (
  <MediaBase.Provider value={mediaBase}>
    <MontageBody timeline={timeline} />
  </MediaBase.Provider>
);

const MontageBody: React.FC<{ timeline: Timeline }> = ({ timeline }) => {
  const { fps } = useVideoConfig();
  const src = useSrc();
  const tl = timeline;
  const style = tl.style ?? {};
  const font = getFont(style.font ?? "Heebo");
  const accent = style.accent ?? "#FFD400";
  const { items, total, openerSeconds } = layoutTimeline(tl);
  const openerF = Math.round(openerSeconds * fps);
  const totalF = Math.max(1, Math.ceil(total * fps));
  const beatFrames = (tl.beats ?? []).map((b) => Math.round(b * fps) + openerF).sort((a, b) => a - b);

  // Music ducking: frames where a clip plays its own sound.
  const loudRanges = items.filter((it) => !it.isOpener && (it.clip.volume ?? 0) > 0)
    .map((it) => [Math.round(it.start * fps), Math.round((it.start + it.duration) * fps)] as const);
  // Music: the main track plus any pieces added by cutting it (music_more). Each piece has its own start (at/shift),
  // end (until) and fades, so a song can be cut, faded out, and followed by another song.
  const musicPieces = [
    ...(tl.music ? [{ m: tl.music, primary: true }] : []),
    ...((tl.music_more ?? []).map((m) => ({ m, primary: false }))),
  ].map(({ m, primary }, k) => {
    const raw = primary
      ? (m.start_at === "opener" ? 0 : openerF) + Math.round((m.shift ?? 0) * fps)
      : openerF + Math.round((m.at ?? 0) * fps);
    const from = Math.max(0, raw);
    const skip = Math.max(0, -raw);                 // moved before the very start: skip into the song instead
    const end = m.until != null ? Math.min(totalF, openerF + Math.round(m.until * fps)) : totalF;
    return { m, k, from, skip, len: end - from };
  }).filter((x) => x.len > 0);
  return (
    <AbsoluteFill style={{ backgroundColor: style.background ?? "#000" }}>
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
        <defs>
          <filter id="mt-r"><feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" /></filter>
          <filter id="mt-g"><feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" /></filter>
          <filter id="mt-b"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" /></filter>
        </defs>
      </svg>
      {items.map((it, i) => {
        const from = Math.round(it.start * fps);
        const dur = Math.max(1, Math.round(it.duration * fps));
        return (
          <Sequence key={`${it.clip.id}-${i}`} from={from} durationInFrames={dur} premountFor={Math.round(fps * 1.5)} name={it.clip.label ?? it.clip.id}>
            <AbsoluteFill style={{ filter: it.isOpener ? undefined : GRADES[style.grade ?? "warm"] }}>
              <ClipLayer item={it} startFrame={from} beatFrames={it.isOpener ? [] : beatFrames} pulse={style.beat_pulse ?? 0} />
            </AbsoluteFill>
            {it.clip.text?.value && (
              <TextOverlay value={it.clip.text.value} position={it.clip.text.position ?? "bottom"} kind={it.clip.text.style ?? "pop"}
                durF={dur - Math.round(it.transOut * fps)} font={font} accent={accent} />
            )}
          </Sequence>
        );
      })}

      {style.vignette !== false && (
        <Sequence from={openerF} name="vignette">
          <AbsoluteFill style={{ background: "radial-gradient(circle at 50% 45%, transparent 55%, rgba(0,0,0,.45) 100%)", pointerEvents: "none" }} />
        </Sequence>
      )}

      {(tl.texts ?? []).map((t: TextItem) => {
        const w = textWindow(t, items, openerSeconds);
        const from = openerF + Math.round(w.start * fps);
        const dur = Math.max(1, Math.round((w.end - w.start) * fps));
        return (
          <Sequence key={t.id} from={from} durationInFrames={dur} name={`text ${t.id}`}>
            <TextOverlay value={t.value} position={t.position ?? "center"} kind={t.style ?? "title"} durF={dur} font={font} accent={accent} />
          </Sequence>
        );
      })}

      {(tl.overlays ?? []).map((o) => {
        const it = o.follow ? items.find((x) => x.clip.id === o.follow) : null;
        const base = it ? it.start : openerSeconds;
        const from = Math.round((base + o.start) * fps), dur = Math.max(1, Math.round((o.end - o.start) * fps));
        return (
          <Sequence key={`ov-${o.id}`} from={from} durationInFrames={dur} premountFor={o.flat ? Math.round(fps) : 0} name={`overlay ${o.id}`}>
            <OverlayCard o={o} durF={dur} filter={GRADES[style.grade ?? "warm"]} />
          </Sequence>
        );
      })}

      {musicPieces.map(({ m, k, from, skip, len }) => (
        <Sequence key={`music-${k}`} from={from} durationInFrames={len} name={`music ${k + 1}`}>
          <Audio
            src={src(m.src)}
            pauseWhenBuffering={false}
            trimBefore={Math.round((m.offset ?? 0) * fps) + skip}
            volume={(f: number) => {
              const g = f + from;
              const base = m.volume ?? 0.8;
              const ducked = loudRanges.some(([a, b]) => g >= a && g < b) ? Math.min(base, m.duck_volume ?? 0.25) : base;
              const fi = Math.max(1, (m.fade_in ?? 0.5) * fps);
              const fo = Math.max(1, (m.fade_out ?? 2) * fps);
              const env = Math.min(1, f / fi, (len - f) / fo);
              return Math.max(0, ducked * env);
            }}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

export const calculateFamilyMontageMetadata: CalculateMetadataFunction<FamilyMontageProps> = async ({ props }) => {
  const tl: Timeline = props.timeline;
  const fps = tl.format?.fps ?? 30;
  const { total } = layoutTimeline(tl);
  return {
    fps,
    width: tl.format?.width ?? 1080,
    height: tl.format?.height ?? 1920,
    durationInFrames: Math.max(1, Math.ceil(total * fps)),
  };
};

export const EMPTY_TIMELINE: Timeline = {
  version: "1.0", title: "Empty montage", format: { width: 1080, height: 1920, fps: 30 },
  opener: null, clips: [], texts: [], music: null, beats: [],
};
