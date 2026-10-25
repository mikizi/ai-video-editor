// Browser bundle for the Backlot timeline editor: a live Remotion <Player>
// running the exact same FamilyMontage composition used for the final render.
// Built with `npm run build:editor` into backlot/ui/editor/montage-player.js
// (committed, so the editor works without a build step). Exposes window.MontagePlayer.
import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
// @ts-ignore -- @types/react-dom is not installed; createRoot is plain JS here.
import { createRoot } from "react-dom/client";
import { Player, PlayerRef } from "@remotion/player";
import { FamilyMontage } from "./FamilyMontage";
import { layoutTimeline, textWindow } from "./layout";
import type { Timeline } from "./types";

type Api = {
  update: (tl: Timeline) => void;
  seek: (seconds: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  isPlaying: () => boolean;
  getTime: () => number;
  fullscreen: () => void;
};

type Opts = { timeline: Timeline; mediaBase: string; onTime?: (s: number) => void; onPlayState?: (p: boolean) => void };

const PlayerHost = React.forwardRef<Api, Opts>(({ timeline: initial, mediaBase, onTime, onPlayState }, ref) => {
  const [tl, setTl] = useState<Timeline>(initial);
  const player = useRef<PlayerRef>(null);
  const fps = tl.format?.fps ?? 30;
  const total = Math.max(1, Math.ceil(layoutTimeline(tl).total * fps));

  useImperativeHandle(ref, () => ({
    update: (t) => setTl(t),
    seek: (s) => player.current?.seekTo(Math.max(0, Math.round(s * fps))),
    play: () => player.current?.play(),
    pause: () => player.current?.pause(),
    toggle: () => player.current?.toggle(),
    isPlaying: () => player.current?.isPlaying() ?? false,
    getTime: () => (player.current?.getCurrentFrame() ?? 0) / fps,
    fullscreen: () => { player.current?.requestFullscreen(); },
  }), [fps]);

  useEffect(() => {
    const p = player.current;
    if (!p) return;
    const onFrame = (e: { detail: { frame: number } }) => onTime?.(e.detail.frame / fps);
    const onPlay = () => onPlayState?.(true);
    const onPause = () => onPlayState?.(false);
    p.addEventListener("frameupdate", onFrame);
    p.addEventListener("play", onPlay);
    p.addEventListener("pause", onPause);
    p.addEventListener("ended", onPause);
    return () => {
      p.removeEventListener("frameupdate", onFrame);
      p.removeEventListener("play", onPlay);
      p.removeEventListener("pause", onPause);
      p.removeEventListener("ended", onPause);
    };
  }, [fps, onTime, onPlayState]);

  return (
    <Player
      ref={player}
      component={FamilyMontage}
      inputProps={{ timeline: tl, mediaBase }}
      durationInFrames={total}
      fps={fps}
      compositionWidth={tl.format?.width ?? 1080}
      compositionHeight={tl.format?.height ?? 1920}
      style={{ width: "100%", height: "100%" }}
      acknowledgeRemotionLicense
      numberOfSharedAudioTags={8}
      clickToPlay
    />
  );
});

function mount(el: HTMLElement, opts: Opts): Api {
  const ref = React.createRef<Api>();
  createRoot(el).render(<PlayerHost ref={ref} {...opts} />);
  const call = <K extends keyof Api>(k: K) => ((...a: unknown[]) => (ref.current as any)?.[k]?.(...a)) as Api[K];
  return {
    update: call("update"), seek: call("seek"), play: call("play"), pause: call("pause"),
    toggle: call("toggle"), isPlaying: () => ref.current?.isPlaying() ?? false, getTime: () => ref.current?.getTime() ?? 0,
    fullscreen: call("fullscreen"),
  };
}

(window as any).MontagePlayer = { mount, layoutTimeline, textWindow };
