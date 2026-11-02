# All changes, numbered

**Total: 79 changes**, in 10 groups.


## Timeline editing (24)
1. Flip a clip
2. Rotate a clip 90 degrees
3. Reverse a clip
4. Crop with drag handles on the preview
5. Duplicate a clip
6. Quick edit bar under the preview
7. Marquee select: drag a box to pick many clips and elements
8. Move several picked items together
9. Delete several picked items together
10. Extra video channels (Video 2 and 3)
11. Three music channels
12. Music cut into pieces and allowed to run past the video
13. Per-track mute, hide and lock
14. Time ruler in hh:mm:ss:ff
15. Pixel rulers on the preview
16. Picture settings: contrast, brightness, colour
17. Picture position, scale and rotate
18. Open-space colour
19. Preview proxies so heavy videos do not show black
20. Bigger handles to extend or shorten a clip
21. Volume changes removed from inside the timeline (moved to the Sound panel)
22. Start a project with an empty timeline
23. Keyboard shortcut editor
24. Keyboard picture showing used and free keys

## Sound (4)
25. Volume line in dB with keyframes
26. Waveforms on clips
27. Sound panel with master meter and fader
28. Smooth ducking of music under speech

## AI chat (10)
29. AI chat panel with preview, Approve and Reject
30. Saved versions, go back to any earlier state
31. Voice notes
32. Attach or paste photos and videos (saved in the project)
33. Inspiration board
34. Style rules learned from the board
35. Cuts Bank of ready-made cuts (106)
36. Search the Cuts Bank, and the AI finds the closest cut
37. The AI works on the clips you picked
38. AI commands for background blur and replace

## Background effects (6)
39. Blur the background behind a person
40. Replace the background with a colour
41. Replace the background with a photo or video
42. Preview the effect before Approve
43. Remove the effect and get the original cut back
44. Background section in clip settings

## Downloads (3)
45. Download the selected clip(s) without an export
46. Download the whole video without an export
47. Still image (PNG) at the playhead

## Media panel (7)
48. Folder dropdown with file counts
49. Search clips and transcripts
50. Thumbnail or list view
51. Sort by name, size or date created
52. Drag and drop files from Finder
53. More columns when the panel is widened
54. Uploads folder and streamed uploads up to 4 GB

## Library page (4)
55. Rename a project
56. Choose a cover photo
57. Automatic cover from the first clip
58. Back to automatic cover

## Look and feel (6)
59. New colour palette (ivory, washed black, tobacco)
60. Cutsmith logo and page titles
61. Three-dot menu in the top bar
62. Three-dot Tools menu under the preview
63. Muted clip, waveform and status colours
64. Library page in the new palette

## Fixes (4)
65. Stray word "null" in the chat header and import bar
66. Motion scene render: pass variables inline (CLI crash)
67. Probe real picture size and audio streams (rotation, EXIF)
68. Remotion composer reads the new timeline fields

## Added later (11)
69. Refresh button: brings in new files from the original folders (Finder, downloads) and reloads the media panel
70. Favorites: a heart on every file, and a filter to show only favorites
71. Small thumbnails view (more files on screen)
72. Remove a folder or a single file from the media bin (moved to a trash folder, never erased; refused if the timeline uses it)
73. Sound effects folder with 13 built-in sounds, shared by all projects (`scripts/make_sound_effects.py` makes them; the .wav files are not in git)
74. Progress bar and seconds counter while a voice note is turned into text
75. Enter sends the message in the AI chat (Shift+Enter makes a new line)
76. "thirds" transition: Marvel-style three horizontal bands slide in one after another (preview and Download)
77. Icons made by the AI chat: 16 shapes in any colour, or any emoji
78. Pop-up bounce animation for layers (`pop` seconds on a layer)
79. Expand to the cut: a split clip remembers where it was cut from and can grow back to it, then to the whole video

---

# Changes since the original version

All changes are in the timeline editor (`backlot/` + the timeline schema + a few small changes in `lib/` and `remotion-composer/`).
The pipeline, tools and agent files are untouched.
Authors: Idan Avitan, with Claude Code. Two commits on top of `a15dba5`: `e6d3804` and `9cf542c`.

How to try it: `python -m backlot serve --port 4750`, open http://localhost:4750/, open any project with a timeline.

## New dependencies (added to `requirements.txt`)
| Package | Used for |
|---|---|
| `faster-whisper` | voice notes in the AI chat, word timings (runs locally) |
| `mediapipe` | cuts the person out of the video (background blur / replace) |
| `opencv-python-headless` | compositing the frames for those effects |

`ffmpeg` and `ffprobe` must be installed (already needed before). The AI chat uses the `claude` command line tool that is installed on the machine.

## 1. Timeline editing (CapCut style)
- Quick tools: split, crop (drag handles on the preview), flip, rotate 90, reverse, duplicate, delete, text, group.
- Marquee select: drag a box on an empty part of the timeline to pick clips, text, extra layers and music, then move or delete them together.
- Extra video channels (Video 2 and 3) on top of the main video, and three music channels.
- Time ruler in hh:mm:ss:ff, per-track mute / hide / lock, pixel rulers on the preview.
- Clip picture settings: contrast, brightness, colour, position/scale/rotate, crop, flip, open-space colour.
- Empty projects: "Start empty" opens the editor with no video yet.
- Preview proxies for big videos, so heavy originals do not show black.

## 2. Sound
- Volume line in dB with keyframes, waveforms on clips, a Sound panel with master meter and fader.
- Music can run past the video, smooth ducking, music cut into pieces.

## 3. AI chat (right panel)
- Ask for changes in plain words; the change shows in the preview first, then Approve or Reject.
- Every approval saves a version; a Versions panel goes back to any earlier state.
- Voice notes (microphone), attach photos or videos with the paperclip (saved in the project's `uploads` folder).
- Inspiration board: screenshots, example videos and notes; the AI learns style rules from them.
- Cuts Bank: a library of ready-made cuts (`public/media/cuts-bank/bank.json`); the AI finds the closest cut to what you say, even with typos, and adds it.

## 4. Background effects (new)
- Blur the background behind a person (0 to 100 %), or replace it with a colour, a photo or a video.
- From the clip settings ("Background") or by asking the AI chat ("blur the background 10%").
- Runs locally: MediaPipe selfie segmentation + OpenCV + ffmpeg (`backlot/bg_fx.py`).
- Makes a new video of just that cut; the original cut is kept in `clip.bgfx.orig`, so the effect can be changed or removed.
- In the AI chat the result is previewed before Approve.

## 5. Downloads without the Remotion export (new)
- "Download": builds an MP4 with ffmpeg only (`backlot/quick_export.py`): the selected clips, or the whole video.
  Includes trims, speed, volume, subtitles/text burned in, extra channels and music.
  Not included: transitions (hard cuts), zoom/pan motion, motion scenes, opener, dB keyframes.
- "Still image": a PNG of the frame at the playhead.
- The full "Export MP4" (Remotion) is still there, under the three-dot menu.

## 6. Media panel
- Folder dropdown with file counts, search, thumbnail or list view, sort by name / size / date created.
- Drag and drop files from Finder into the panel (streamed to disk, up to 4 GB per file).
- Resizing the panel adds columns instead of enlarging thumbnails.

## 7. Library page
- Rename a project, choose a cover photo, or an automatic cover from the first clip.

## 8. Look and feel
- New colour system: warm ivory, washed black, tobacco (tokens at the top of `editor.css`).
- Cutsmith logo (`backlot/ui/editor/cutsmith-logo.png`), page titles say "Cutsmith". Easy to revert if you want to keep the original name.
- Less visible buttons: rarely used actions live under three-dot menus.
- Keyboard shortcut editor (⌨ Keys) with a keyboard picture showing used and free keys.

## API additions (`/api/editor/...`)
`quick-export` (POST, GET, `/file`), `still`, `bgfx` (POST, GET), `upload`, `rename`, `cover`, `favorites`, `sync-links`, `folder/remove`, `media/remove`, `library-search`, `chat` (POST, GET), `versions`, `inspiration*`, `transcribe`, `stt/warm`, `waveform`, `reverse`, `pick-folder`.
`GET /thumb/{project}/{path}` accepts `t=` (frame time). `/api/projects` returns `poster_t` and `poster_v`.

## Timeline schema (`schemas/artifacts/timeline.schema.json`)
- Top level: `layers`, `tracks`, `master_db`.
- Clip: `adjust`, `bg`, `bgfx`, `crop`, `cut_from`, `dim`, `flip`, `reversed`, `transform`, `vol`. Layer: `pop`. Transition type: `thirds`.
- Remotion composer: `FamilyMontage.tsx`, `layout.ts`, `types.ts` read the new fields so previews and exports match.

## Other fixes
- `lib/motion_scenes.py`: pass `--variables` inline (the `--variables-file` option crashes on the HyperFrames CLI version we use).
- `lib/timeline.py`: probe for audio streams and the real displayed size (rotation, EXIF).

## Known limits
- Download and Still do not do transitions or zoom/pan.
- Background effects need a person in the frame; they work frame by frame (about as long as the clip).
- The Remotion MP4 export could not be run on macOS 13 on our machine.
- Tests: `tests/backlot/test_editor_new_features.py` covers icons, the new schema fields, favorites and folder removal. The rest was checked by hand and with headless-browser runs.
- `tests/backlot/test_ui_bug_bash.py` has 14 failures that were already there on `main` before these changes.
