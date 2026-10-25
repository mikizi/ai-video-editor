// Types for the montage timeline. Source of truth for the shape:
// schemas/artifacts/timeline.schema.json

export type TransitionType =
  | "cut" | "fade" | "flash" | "zoom" | "slide-left" | "slide-up" | "whip" | "dip-black" | "shutter" | "whip-right" | "whip-up" | "zoom-through"
  | "spin" | "flip" | "iris" | "wipe-diag" | "glitch" | "blur-dissolve" | "light-leak" | "shake" | "window" | "reveal-up" | "tunnel";
export type Motion = "none" | "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "punch";
export type Fit = "cover" | "contain" | "blur-fill";
export type TextPosition = "top" | "center" | "bottom";
export type TextStyle = "pop" | "subtitle" | "title" | "cine";

// "window": the incoming clip opens out of a picture-in-picture card (x, y = centre, width = card width, all as fractions of the frame).
export interface Transition { type: TransitionType; seconds?: number; x?: number; y?: number; width?: number }

export interface Clip {
  id: string;
  src: string;
  kind: "video" | "image";
  label?: string;
  in?: number;
  out?: number;
  hold?: number;
  source_duration?: number;
  speed?: number;
  volume?: number;
  fit?: Fit;
  focus?: { x?: number; y?: number };
  rotate?: 0 | 90 | 180 | 270;
  zoom?: number;
  pip?: Pip;
  locked?: boolean;
  at?: number;
  motion?: Motion;
  transition?: Transition;
  text?: { value: string; position?: TextPosition; style?: TextStyle };
  reason?: string;
}

export interface TextItem {
  follow?: string;
  id: string; value: string; start: number; end: number;
  position?: TextPosition; style?: TextStyle;
}

export interface Timeline {
  version: "1.0";
  title?: string;
  format?: { width?: number; height?: number; fps?: number };
  style?: {
    font?: "Heebo" | "Rubik" | "Assistant" | "Anton" | "Montserrat";
    accent?: string;
    grade?: "none" | "warm" | "cool" | "vivid" | "film" | "bw";
    vignette?: boolean;
    beat_pulse?: number;
    background?: string;
  };
  opener?: { src: string; seconds: number; fit?: Fit } | null;
  clips: Clip[];
  texts?: TextItem[];
  music?: Music | null;
  music_more?: Music[];
  overlays?: Overlay[];
  beats?: number[];
  metadata?: Record<string, unknown>;
}

export type FamilyMontageProps = { timeline: Timeline; mediaBase?: string };

// A second shot shown as a small tilted "photo" card on top of the clip (picture-in-picture).
export interface Pip {
  src: string; in?: number; out?: number;
  x?: number; y?: number;        // card centre as a fraction of the frame (default 0.78, 0.5)
  width?: number;                // card width as a fraction of the frame width (default 0.24)
  rotate?: number;               // tilt in degrees (default 3)
  delay?: number;                // seconds after the clip starts before it pops in (default 0.25)
  speed?: number;
}

export interface Music {
  src: string; offset?: number; volume?: number; duck_volume?: number;
  fade_in?: number; fade_out?: number; start_at?: "opener" | "clips"; shift?: number; until?: number; at?: number;
}

export interface Overlay {
  id: string; src: string; follow?: string; start: number; end: number;
  x?: number; y?: number; width?: number; aspect?: number; rotate?: number;
  reveal?: boolean; reveal_seconds?: number; reveal_from?: "bottom" | "top"; exit?: "up" | "down"; exit_seconds?: number; speed?: number;   // flat only: wipe up from the bottom; playback speed
  flat?: boolean;   // split-screen column: no border/rounding/entrance, edge to edge
  in?: number;   // start the video this many seconds in (so one file can feed several cards)
}
