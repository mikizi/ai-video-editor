// Timeline layout math. MUST stay identical to lib/timeline.py `layout()`.
import type { Clip, TextItem, Timeline, Transition } from "./types";

export const DEFAULT_IMAGE_HOLD = 2.5;
export const DEFAULT_TRANSITION_SECONDS = 0.35;

export interface LaidOut {
  clip: Clip;
  isOpener: boolean;
  start: number;       // seconds, global
  duration: number;    // seconds
  transIn: number;     // seconds of overlap with the previous item
  transInType: Transition["type"];
  transOut: number;    // seconds of overlap with the next item
  transOutType: Transition["type"];
  transOutTr?: Transition;   // the next clip's transition object (x/y/width for "window" / "tunnel")
}

export const clipSeconds = (c: Clip): number =>
  c.kind === "image"
    ? c.hold ?? DEFAULT_IMAGE_HOLD
    : ((c.out ?? 0) - (c.in ?? 0)) / (c.speed || 1);

const transSeconds = (t: Transition | undefined, prevLen: number, thisLen: number) => {
  if (!t || t.type === "cut" || t.type === "shutter") return 0;
  const want = t.seconds ?? DEFAULT_TRANSITION_SECONDS;
  return Math.max(0, Math.min(want, prevLen / 2, thisLen / 2));
};

export function layoutTimeline(tl: Timeline): { items: LaidOut[]; total: number; openerSeconds: number } {
  const items: LaidOut[] = [];
  const op = tl.opener ?? null;
  const openerSeconds = op ? op.seconds : 0;
  if (op) {
    items.push({
      clip: { id: "__opener", src: op.src, kind: "video", in: 0, out: op.seconds, volume: 1, fit: op.fit ?? "contain", motion: "none" },
      isOpener: true, start: 0, duration: openerSeconds,
      transIn: 0, transInType: "cut", transOut: 0, transOutType: "cut",
    });
  }
  let cursor = openerSeconds;
  let prevLen = openerSeconds;
  tl.clips.forEach((clip, i) => {
    const len = clipSeconds(clip);
    const hasPrev = i > 0 || openerSeconds > 0;
    let t = hasPrev ? transSeconds(clip.transition, prevLen, len) : 0;
    let start = cursor - t;
    // A pinned (locked) clip keeps its time: if the clips before it got shorter, a gap opens instead of it shifting.
    if (clip.at !== undefined && clip.at >= cursor - 1e-6) { start = clip.at; t = 0; }
    const type = t > 0 ? (clip.transition?.type ?? "cut") : "cut";
    if (items.length) {
      items[items.length - 1].transOut = t;
      items[items.length - 1].transOutType = type;
      items[items.length - 1].transOutTr = clip.transition;
    }
    items.push({ clip, isOpener: false, start, duration: len, transIn: t, transInType: type, transOut: 0, transOutType: "cut" });
    cursor = start + len;
    prevLen = len;
  });
  return { items, total: Math.max(cursor, openerSeconds), openerSeconds };
}

// Where a text sits on the montage clock (0 = just after the opener). A text with `follow` is relative to the start of that clip.
export function textWindow(t: TextItem, items: LaidOut[], openerSeconds: number): { start: number; end: number } {
  if (t.follow) {
    const it = items.find((x) => x.clip.id === t.follow);
    if (it) { const base = it.start - openerSeconds; return { start: base + t.start, end: base + t.end }; }
  }
  return { start: t.start, end: t.end };
}
