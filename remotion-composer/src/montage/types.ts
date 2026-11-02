// Types for the montage timeline. Source of truth for the shape:
// schemas/artifacts/timeline.schema.json

export type TransitionType =
  | "cut" | "fade" | "flash" | "zoom" | "slide-left" | "slide-up" | "whip" | "dip-black" | "shutter" | "whip-right" | "whip-up" | "zoom-through"
  | "spin" | "flip" | "iris" | "wipe-diag" | "glitch" | "blur-dissolve" | "light-leak" | "shake" | "window" | "reveal-up" | "tunnel" | "thirds";
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
  adjust?: Adjust;
  dim?: [number, number];  // the picture's own pixel size; with transform / crop the picture is placed at its true size (like CapCut) instead of being cut to the frame first
  crop?: Crop;             // cut the edges of the picture (fractions 0 to 0.95 of the picture, before it is moved)
  transform?: Transform;   // move / resize / tilt the picture inside the frame (open space shows `bg`, or the project background)
  vol?: VolPoint[];
  _hide?: boolean;         // set in memory from tracks.v1.hide, never saved
  flip?: { h?: boolean; v?: boolean };   // mirror the picture
  reversed?: { src: string; in: number; out: number; source_duration?: number };   // set when the clip plays backwards: the original, so it can be undone
  bg?: string;             // colour of the open space around a moved or shrunk picture
}

// Per-clip picture tweaks (1 = unchanged).
// Position of the picture inside the frame. x, y = offset as a fraction of the frame width / height (0 = centred), scale 1 = fills the frame, rotate in degrees.
export interface Transform { x?: number; y?: number; scale?: number; rotate?: number }
export interface Crop { l?: number; t?: number; r?: number; b?: number }
export interface Adjust { contrast?: number; brightness?: number; saturation?: number }

// A clip on an extra video channel (lane 2 or 3), drawn on top of the main video for a time range on the montage clock.
export interface Layer {
  id: string; lane: 2 | 3; src: string; kind: "video" | "image";
  start: number; end: number; in?: number; speed?: number; volume?: number;
  fit?: "cover" | "contain"; x?: number; y?: number; width?: number;   // x, y = centre, width = fractions of the frame (default: full frame)
  opacity?: number; adjust?: Adjust; label?: string;
  dim?: [number, number];
  crop?: Crop;
  transform?: Transform;   // picture-in-picture: scale < 1 makes a smaller video on top of the main one, x / y move it
  flip?: { h?: boolean; v?: boolean };
  vol?: VolPoint[];
  rounded?: boolean;       // rounded corners and a soft shadow (nice for picture-in-picture)
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
  layers?: Layer[];
  master_db?: number;      // master volume in dB (0 = unchanged)
  tracks?: Record<string, { mute?: boolean; hide?: boolean; lock?: boolean }>;   // per-track mute / hide / lock (v1 v2 v3 m1 m2 m3)
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

export interface VolPoint { t: number; db: number }   // volume line: seconds from the start, decibels relative to the base volume

export interface Music {
  vol?: VolPoint[];
  src: string; offset?: number; volume?: number; duck_volume?: number;
  lane?: 1 | 2 | 3; fade_in?: number; fade_out?: number; start_at?: "opener" | "clips"; shift?: number; until?: number; at?: number;
}

export interface Overlay {
  id: string; src: string; follow?: string; start: number; end: number;
  x?: number; y?: number; width?: number; aspect?: number; rotate?: number;
  reveal?: boolean; reveal_seconds?: number; reveal_from?: "bottom" | "top"; exit?: "up" | "down"; exit_seconds?: number; speed?: number;   // flat only: wipe up from the bottom; playback speed
  flat?: boolean;   // split-screen column: no border/rounding/entrance, edge to edge
  in?: number;   // start the video this many seconds in (so one file can feed several cards)
}
