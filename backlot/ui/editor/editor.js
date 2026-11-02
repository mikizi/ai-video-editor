// Montage editor — CapCut-style timeline editor for artifacts/timeline.json.
// The preview is a live Remotion <Player> running the same FamilyMontage
// composition as the final render (window.MontagePlayer, montage-player.js).

const $ = (s) => document.querySelector(s);
const ID = decodeURIComponent(location.pathname.split("/").filter(Boolean)[1] || "");
const API = `/api/editor/${encodeURIComponent(ID)}`;
const MEDIA_BASE = `/media/${encodeURIComponent(ID)}/public/`;
const thumbUrl = (src, w = 320) => `/thumb/${encodeURIComponent(ID)}/public/${src.split("/").map(encodeURIComponent).join("/")}?w=${w}`;

const TRANSITIONS = ["cut", "fade", "flash", "zoom", "whip", "slide-left", "slide-up", "dip-black", "shutter", "whip-right", "whip-up", "zoom-through", "spin", "flip", "iris", "wipe-diag", "glitch", "blur-dissolve", "light-leak", "shake", "window", "reveal-up", "tunnel", "thirds"];
const MOTIONS = ["none", "punch", "zoom-in", "zoom-out", "pan-left", "pan-right"];
const FITS = ["cover", "contain", "blur-fill"];
const TEXT_STYLES = ["pop", "subtitle", "title", "cine"];
const POSITIONS = ["top", "center", "bottom"];
const GRADES = ["none", "warm", "cool", "vivid", "film", "bw"];
const FONTS = ["Heebo", "Rubik", "Assistant", "Anton", "Montserrat"];
const ASPECTS = { "9:16": [1080, 1920], "16:9": [1920, 1080], "1:1": [1080, 1080], "4:5": [1080, 1350] };
// Where the video is going. One tap sets the right size, so nobody has to know the pixel numbers.
const PLATFORMS = [
  { name: "Reels / Shorts / TikTok", size: [1080, 1920], note: "Tall, full phone screen. Instagram Reels, YouTube Shorts, TikTok, Facebook Reels." },
  { name: "IG / FB Feed", size: [1080, 1350], note: "Tall 4:5. Takes the most room in the Instagram and Facebook feed." },
  { name: "Square", size: [1080, 1080], note: "Square 1:1. Works in every feed, LinkedIn and X too." },
  { name: "YouTube / Wide", size: [1920, 1080], note: "Wide 16:9. YouTube, websites, TV, LinkedIn and X." },
];
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];

const S = {
  tl: null, mtime: null, media: [], binTab: "all",
  sel: null,                 // {t: "clip"|"text"|"music", id}
  undo: [], redo: [], lastKey: null, lastAt: 0,
  dirty: false, saving: false, saveTimer: null, conflict: null,
  time: 0, playing: false, pps: 90, render: null,
  motion: { templates: [], tpl: null, values: {}, seconds: null, job: null, edit: null },
};
S.cm = { open: false, tab: "todo", draft: "", flash: null };
S.chat = { open: true, msgs: [], busy: false, pending: null, showBefore: false, startedAt: 0 };
S.ver = { open: false, list: [] };
S.bank = { cuts: [], cat: "All", q: "", loaded: false };
S.binQ = ""; S.binHits = [];   // the Media panel search box and its Cuts Bank matches   // Cuts Bank: cuts that point into the original videos
S.board = { items: [], rules: [], view: "refs" };   // inspiration board: references -> analysis -> rules the AI chat follows
S.analyse = { busy: false, msg: "", err: false };
S.rulers = true;
try { if (localStorage.getItem("montage-rulers") === "0") S.rulers = false; } catch { /* storage blocked */ }
S.binW = (() => { try { return Math.min(900, Math.max(220, +localStorage.getItem("montage-bin-w") || 290)); } catch { return 290; } })();   // media panel width: drag its edge
S.binShut = new Set();                      // bin folders the user folded away
S.panels = { bin: false, insp: false };     // side panels start closed so the preview and timeline get the room
try { for (const k of ["bin", "insp"]) { const v = localStorage.getItem("montage-panel-" + k); if (v != null) S.panels[k] = v === "1"; } } catch { /* storage blocked */ }
try { if (localStorage.getItem("montage-chat-open") === "0") S.chat.open = false; } catch { /* storage blocked */ }
let player = null;

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
const clone = (o) => JSON.parse(JSON.stringify(o));
const r3 = (n) => Math.round(n * 1000) / 1000;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`; };
// CapCut's time format: hours:minutes:seconds:frames
const tc = (s) => { const fps = S.tl?.format?.fps ?? 30, f = Math.round(Math.max(0, s) * fps), p = (n) => String(n).padStart(2, "0"); return `${p(Math.floor(f / fps / 3600))}:${p(Math.floor(f / fps / 60) % 60)}:${p(Math.floor(f / fps) % 60)}:${p(f % fps)}`; };
const newId = (p = "c") => p + Math.random().toString(36).slice(2, 7);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
};
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 4500); }
const lay = () => window.MontagePlayer.layoutTimeline(S.tl);
const clipLen = (c) => c.kind === "image" ? (c.hold ?? 2.5) : ((c.out ?? 0) - (c.in ?? 0)) / (c.speed || 1);
const findClip = (id) => S.tl.clips.find((c) => c.id === id);
const clipIndex = (id) => S.tl.clips.findIndex((c) => c.id === id);
const mediaInfo = (src) => (typeof src === "string" && src.startsWith("bank:") ? bankById(src.slice(5)) : S.media.find((m) => m.src === src));
const groupOf = (id) => (S.tl.groups || []).find((g) => g.id === id);
// Music pieces: index 0 = the main track (tl.music), 1.. = pieces made by cutting it (tl.music_more[i-1]).
const musicAt = (tl, i = 0) => (i === 0 ? tl.music : (tl.music_more || [])[i - 1]);
const musicCount = (tl) => (tl.music ? 1 : 0) + (tl.music_more || []).length;
const selMusic = () => S.sel?.t === "music" ? (S.sel.i || 0) : 0;
// Where a music piece starts/ends on the montage clock (0 = just after the opener).
function musicSpan(tl, i) {
  const m = musicAt(tl, i), opener = tl.opener ? tl.opener.seconds : 0, total = window.MontagePlayer.layoutTimeline(tl).clipsTotal - opener;
  const start = i === 0 ? Math.max(-opener, (m.start_at === "opener" ? -opener : 0) + (m.shift || 0)) : (m.at || 0);
  const song = (S.media.find((x) => x.src === m.src)?.duration) || 3600;   // a song cannot be stretched past its own length
  const s0 = Math.max(0, start);
  return { start: s0, end: m.until != null ? m.until : total, total, max: s0 + Math.max(1, song - (m.offset ?? 0)) };
}
const groupClips = (gid) => S.tl.clips.filter((c) => c.group === gid);
// ---- Locks: a locked item cannot be moved, trimmed, edited or deleted until released.
// A locked clip is also PINNED (clip.at): clips before it can change without shifting it - a gap opens instead.
const isLocked = (c) => !!c.locked || !!(c.group && groupOf(c.group)?.locked) || !!S.tl.tracks?.v1?.lock;
const stripLock = (o) => { const x = { ...o }; delete x.locked; delete x.at; return JSON.stringify(x); };
function lockViolation(before, after) {
  const gB = (tl, c) => (tl.groups || []).find((g) => g.id === c.group)?.locked;
  for (const c of before.clips) {
    if (!(c.locked || gB(before, c))) continue;
    const a = after.clips.find((x) => x.id === c.id);
    if (!a || stripLock(a) !== stripLock(c)) return c.label || c.id;
  }
  const pinned = after.clips.filter((c) => c.at !== undefined);
  if (pinned.length) {
    const items = window.MontagePlayer.layoutTimeline(after).items;
    for (const c of pinned) { const it = items.find((x) => x.clip.id === c.id); if (it && Math.abs(it.start - c.at) > 0.01) return (c.label || c.id) + " (no room before it)"; }
  }
  for (const t of before.texts || []) if (t.locked) { const a = (after.texts || []).find((x) => x.id === t.id); if (!a || stripLock(a) !== stripLock(t)) return "text " + t.value.split("\n")[0]; }
  if (before.music?.locked && (!after.music || stripLock(after.music) !== stripLock(before.music))) return "music";
  for (const g of before.groups || []) if (g.locked) {
    const a = (after.groups || []).find((x) => x.id === g.id);
    const mem = (tl) => tl.clips.filter((c) => c.group === g.id).map((c) => c.id).join(",");
    if (!a || stripLock(a) !== stripLock(g) || mem(before) !== mem(after)) return g.name;
  }
  return null;
}
function toggleLock(kind, id) {
  commit((tl) => {
    if (kind === "clip") {
      const c = tl.clips.find((x) => x.id === id);
      if (c.locked) { delete c.locked; delete c.at; }
      else { c.locked = true; c.at = r3(window.MontagePlayer.layoutTimeline(tl).items.find((x) => x.clip.id === id).start); }
    } else if (kind === "group") {
      const g = tl.groups.find((x) => x.id === id), first = tl.clips.find((c) => c.group === id);
      if (g.locked) { delete g.locked; if (first) delete first.at; }
      else { g.locked = true; if (first) first.at = r3(window.MontagePlayer.layoutTimeline(tl).items.find((x) => x.clip.id === first.id).start); }
    } else if (kind === "text") { const t = tl.texts.find((x) => x.id === id); if (t.locked) delete t.locked; else t.locked = true; }
    else if (kind === "music") { if (tl.music.locked) delete tl.music.locked; else tl.music.locked = true; }
  });
  renderAll();
}
// Put a lock bar on top of an inspector and disable all its fields while locked.
function withLock(root, locked, toggle, what) {
  const bar = el("div", { class: "lockbar" + (locked ? " on" : "") },
    el("button", { onclick: toggle, title: "Lock: it can't be moved, trimmed or edited until you release it (L)" }, locked ? `🔒 ${what} locked - click to release` : `🔓 Lock ${what}`));
  if (locked) {
    const fs = el("fieldset", { disabled: "", class: "lockfs" });
    for (const ch of [...root.children]) fs.append(ch);
    root.append(el("div", { class: "hint" }, "Locked: it stays exactly where it is (clips before it can change, a gap opens instead). Release the lock to edit it."), fs);
  }
  root.prepend(bar); return root;
}
// A compound clip can have a fixed length (group.seconds): inner edits then change its last clip so the total stays the same
// and nothing after the group moves.
function groupSpan(tl, gid) {
  const items = window.MontagePlayer.layoutTimeline(tl).items.filter((x) => x.clip.group === gid);
  return items.length ? { start: items[0].start, len: items[items.length - 1].start + items[items.length - 1].duration - items[0].start } : null;
}
function enforceGroupLengths(tl) {
  // Returns the name of a group that could not keep its length (or null when all is fine).
  for (const g of tl.groups || []) {
    if (!g.seconds) continue;
    for (let pass = 0; pass < 4; pass++) {
      const span = groupSpan(tl, g.id); if (!span) break;
      let delta = g.seconds - span.len; if (Math.abs(delta) < 0.004) break;
      const mem = tl.clips.filter((c) => c.group === g.id);
      for (let i = mem.length - 1; i >= 0 && Math.abs(delta) >= 0.004; i--) {     // the last clip absorbs first, then the ones before it
        const c = mem[i];
        if (c.kind === "image") { const h = r3(Math.max(0.3, (c.hold ?? 2.5) + delta)); delta -= h - (c.hold ?? 2.5); c.hold = h; }
        else {
          const sp = c.speed || 1, max = c.source_duration ?? Infinity;
          const out = r3(clamp(c.out + delta * sp, c.in + 0.2 * sp, max)); delta -= (out - c.out) / sp; c.out = out;
        }
      }
    }
    const span = groupSpan(tl, g.id);
    if (span && Math.abs(g.seconds - span.len) > 0.02) return g.name;
  }
  return null;
}
S.multi = [], S.multiX = []; // ids of clips picked with shift-click (a consecutive range), for "Group"

// ---------------------------------------------------------------------------
// Edits: every change goes through commit() -> undo stack, render, autosave.
// ---------------------------------------------------------------------------
function commit(mutate, key = null) {
  const now = Date.now();
  const coalesce = key && key === S.lastKey && now - S.lastAt < 900;
  if (!coalesce) { S.undo.push(clone(S.tl)); if (S.undo.length > 200) S.undo.shift(); }
  S.lastKey = key; S.lastAt = now;
  const anyLock = (S.tl.groups || []).some((g) => g.seconds || g.locked) || S.tl.clips.some((c) => c.locked || c.at !== undefined) || (S.tl.texts || []).some((t) => t.locked) || S.tl.music?.locked;
  const before = anyLock ? clone(S.tl) : null;
  mutate(S.tl);
  const bad = before ? enforceGroupLengths(S.tl) : null;
  if (bad) {                                   // would change the length of a fixed-length group (and move what comes after) -> refuse
    S.tl = before; if (!coalesce) S.undo.pop();
    toast(`Not changed: "${bad}" is fixed at its length and has no more footage to absorb that. Unlock it or change its length first.`);
    renderAll(); return;
  }
  const lv = before ? lockViolation(before, S.tl) : null;
  if (lv) {
    S.tl = before; if (!coalesce) S.undo.pop();
    toast(`Locked: "${lv}" can't be changed. Release its lock first (🔒 in the panel, or press L).`);
    renderAll(); return;
  }
  S.redo = [];
  changed();
}
function changed({ save = true } = {}) {
  if (S.sel && S.sel.t === "clip" && !findClip(S.sel.id)) S.sel = null;
  if (S.sel && S.sel.t === "text" && !(S.tl.texts || []).find((t) => t.id === S.sel.id)) S.sel = null;
  if (S.sel && S.sel.t === "music" && !musicAt(S.tl, S.sel.i || 0)) S.sel = null;
  if (S.sel && S.sel.t === "group" && !groupOf(S.sel.id)) S.sel = null;
  if (S.sel && S.sel.t === "layer" && !(S.tl.layers || []).find((l) => l.id === S.sel.id)) S.sel = null;
  if (S.chat.pending) S.chat.showBefore = false;
  player?.update(clone(S.tl));
  renderAll();
  if (save) { S.dirty = true; scheduleSave(); }
}
function undo() { if (!S.undo.length) return;
  if (S.chat.pending && S.undo.length <= S.chat.pending.undoBase.length) { toast("That is where the AI change starts. Press Reject to drop it."); return; } const cm = S.tl.comments; S.redo.push(clone(S.tl)); S.tl = S.undo.pop(); keepComments(cm); S.lastKey = null; changed(); }
function redo() { if (!S.redo.length) return; const cm = S.tl.comments; S.undo.push(clone(S.tl)); S.tl = S.redo.pop(); keepComments(cm); S.lastKey = null; changed(); }

// ---------------------------------------------------------------------------
// Load / save / live sync with Claude
// ---------------------------------------------------------------------------
async function api(path, opts = {}) {
  const r = await fetch(API + path, { headers: { "Content-Type": "application/json" }, ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(typeof body.detail === "string" ? body.detail : (body.detail?.message || r.statusText)); e.status = r.status; e.body = body; throw e; }
  return body;
}
function scheduleSave() { clearTimeout(S.saveTimer); S.saveTimer = setTimeout(save, 600); renderSave(); }
async function save(force = false) {
  if (!S.tl || S.saving || S.conflict || S.chat.pending) return;   // an AI change under review is never written to disk until approved
  S.saving = true; renderSave();
  try {
    const r = await api("/timeline", { method: "PUT", body: JSON.stringify({ timeline: S.tl, base_mtime: S.mtime, force }) });
    S.mtime = r.mtime; S.dirty = false;
  } catch (e) {
    if (e.status === 409) showConflict(e.body.detail);
    else toast("Not saved: " + e.message);
  } finally { S.saving = false; renderSave(); }
}
function renderSave() {
  const n = $("#save");
  n.className = "save" + (S.dirty ? " dirty" : "");
  if (S.chat.pending) { n.className = "save dirty"; n.textContent = "Reviewing AI change"; $("#undo").disabled = !S.undo.length; $("#redo").disabled = !S.redo.length; return; }
  n.textContent = S.saving ? "Saving…" : S.dirty ? "Unsaved" : S.conflict ? "Conflict" : "Saved ✓";
  $("#undo").disabled = !S.undo.length; $("#redo").disabled = !S.redo.length;
}
function showConflict(detail) {
  S.conflict = detail;
  const b = $("#banner");
  b.replaceChildren(
    el("span", {}, "The timeline was changed outside the editor (maybe by Claude)."),
    el("button", { onclick: () => { S.undo.push(clone(S.tl)); S.tl = detail.timeline; S.mtime = detail.mtime; S.dirty = false; hideConflict(); changed({ save: false }); toast("Loaded the newest version"); } }, "Load theirs"),
    el("button", { onclick: () => { hideConflict(); save(true); } }, "Keep mine"),
  );
  b.classList.remove("hidden"); document.body.classList.add("has-banner");
}
function hideConflict() { S.conflict = null; $("#banner").classList.add("hidden"); document.body.classList.remove("has-banner"); renderSave(); }

async function loadTimeline() {
  const r = await api("/timeline");
  if (!r.timeline) { showEmpty(r.error); return false; }
  S.tl = r.timeline; S.mtime = r.mtime;
  $("#empty").classList.add("hidden");
  return true;
}
async function refreshFromDisk() {
  if (S.saving) return;
  const r = await api("/timeline").catch(() => null);
  if (!r || !r.timeline || r.mtime === S.mtime) return;
  if (S.dirty) { showConflict({ timeline: r.timeline, mtime: r.mtime }); return; }
  if (S.chat.pending) chatReject(true);
  S.undo.push(clone(S.tl)); S.tl = r.timeline; S.mtime = r.mtime;
  changed({ save: false }); toast("Timeline updated");
}
// Favorites: a heart on a file in the media bin (saved in the project, favorites.json)
S.favs = new Set(); S.favOnly = false;
async function loadFavs() { try { S.favs = new Set((await api("/favorites")).favorites || []); } catch { /* keep what we have */ } }
async function toggleFav(src) {
  const on = !S.favs.has(src);
  on ? S.favs.add(src) : S.favs.delete(src);
  renderBin();
  try { await api("/favorites", { method: "POST", body: JSON.stringify({ src, on }) }); }
  catch (e) { on ? S.favs.delete(src) : S.favs.add(src); renderBin(); toast("Could not save the favorite: " + e.message); }
}
const heartBtn = (m) => el("button", { class: `heart${S.favs.has(m.src) ? " on" : ""}`, title: S.favs.has(m.src) ? "Remove from favorites" : "Add to favorites",
  onclick: (e) => { e.stopPropagation(); toggleFav(m.src); } }, S.favs.has(m.src) ? "♥" : "♡");
async function loadMedia() { S.media = (await api("/media")).media; await loadFavs(); if (!S.bank.loaded) { await loadBank(); S.bank.loaded = true; } renderBin(); }

async function emptyCount() {
  const s = await api("/sources").catch(() => null);
  const n = s?.in_bin ?? 0;
  $("#emptyCount").textContent = n ? `${n} photos/videos ready in the media bin. Make a first draft from them.` : "No media yet. Import photos and videos first (a folder, this project's source media, or Google Photos).";
  $("#emptyDraft").disabled = !n;
}
function showEmpty(err) {
  $("#empty").classList.remove("hidden");
  $("#emptyImport").onclick = openImporter;
  emptyCount();
  $("#emptyErr").textContent = err ? "timeline.json has a problem: " + err : "";
  $("#emptyBlank").onclick = async () => {
    try {
      const r = await api("/draft", { method: "POST", body: JSON.stringify({ aspect: $("#emptyAspect").value, overwrite: !!err, empty: true }) });
      S.tl = r.timeline; S.mtime = r.mtime; $("#empty").classList.add("hidden"); start();
    } catch (e) { $("#emptyErr").textContent = e.message; }
  };
  $("#emptyDraft").onclick = async () => {
    try {
      const r = await api("/draft", { method: "POST", body: JSON.stringify({ aspect: $("#emptyAspect").value, overwrite: !!err }) });
      S.tl = r.timeline; S.mtime = r.mtime; $("#empty").classList.add("hidden"); start();
    } catch (e) { $("#emptyErr").textContent = e.message; }
  };
}

// ---------------------------------------------------------------------------
// Import media (project source folders, any folder on this Mac, Google Photos)
// ---------------------------------------------------------------------------
async function openImporter() {
  const box = $("#importer");
  const close = () => { box.classList.add("hidden"); box.replaceChildren(); };
  const msg = el("div", { class: "imp-msg" });
  const say = (t, err) => { msg.textContent = t; msg.classList.toggle("err", !!err); };
  const done = async (added, found, ignored = {}, folder = "") => {
    await loadMedia();
    if (!S.tl) emptyCount();
    const skipped = Object.entries(ignored).map(([e, n]) => `${n} ${e}`).join(", ");
    const kept = found - added;
    await list();
    say((added ? `Added ${added} file${added === 1 ? "" : "s"}${folder ? ` from ${folder}` : ""} to the media bin.` : `Nothing new: all ${found} files are already in the bin.`)
      + (added && kept ? ` ${kept} were already there.` : "")
      + (skipped ? ` Not imported (unsupported type): ${skipped}.` : ""));
    if (added) { S.binTab = "all"; setPanel("bin", true); renderBin(); }   // the bin is closed by default: open it so the new files are visible
  };
  const body = el("div", {});
  async function list() {
    const src = await api("/sources").catch(() => ({ folders: [], in_bin: 0 }));
    body.replaceChildren(
      el("div", { class: "sec-t" }, `In the media bin: ${src.in_bin}`),
      el("div", { class: "sec-t" }, "This project's source media"),
      ...(src.folders.length ? src.folders.map((f) => el("div", { class: "imp-row" }, el("span", {}, `${f.path} · ${f.count} files`),
        el("button", { onclick: async () => { say("Importing…"); try { const r = await api("/import", { method: "POST", body: JSON.stringify({ folder: f.path }) }); done(r.added, r.found, r.ignored, r.folder); } catch (e) { say(e.message, true); } } }, "Import")))
        : [el("div", { class: "hint" }, "No source-media folders in this project.")]),
      el("div", { class: "sec-t" }, "A folder on this Mac"),
      el("div", { class: "imp-row" }, el("span", {}, "Pick a folder in Finder. Every photo and video inside it is added to the media bin."),
        el("button", { class: "primary", onclick: chooseFolder }, "Choose folder…")),
      el("div", { class: "sec-t" }, "Google Photos"),
      el("div", { class: "imp-row" }, el("span", {}, "Opens a Google tab on this Mac. Pick the photos/videos, press Done."),
        el("button", { id: "gpBtn", onclick: googlePhotos }, "Open picker")),
      msg);
  }
  async function chooseFolder() {
    say("Choose a folder in the Finder window (it may be behind this browser)…");
    try {
      const pr = await fetch("/api/editor/pick-folder", { method: "POST" });     // not project-scoped
      const pick = await pr.json().catch(() => ({}));
      if (!pr.ok) throw new Error(typeof pick.detail === "string" ? pick.detail : "Could not open the folder picker");
      if (pick.cancelled) { say("No folder chosen."); return; }
      say(`Importing from ${pick.path} …`);
      const r = await api("/import", { method: "POST", body: JSON.stringify({ folder: pick.path }) });
      done(r.added, r.found, r.ignored, r.folder);
    } catch (e) { say(e.message, true); }
  }
  async function googlePhotos() {
    say("Waiting for you to pick in the Google Photos tab…");
    try { await api("/google-photos", { method: "POST" }); } catch (e) { say(e.message, true); return; }
    let j;
    do { await new Promise((r) => setTimeout(r, 1500)); j = await api("/google-photos").catch(() => ({ running: false })); } while (j.running);
    if (j.ok) done(j.added, j.added); else say(j.error || "Google Photos failed", true);
  }
  box.replaceChildren(el("div", { class: "imp-card" }, el("div", { class: "imp-head" }, el("h2", {}, "Import media"), el("button", { onclick: close }, "✕")), body));
  box.classList.remove("hidden");
  list();
}

// Switch between projects without going back to the Library.
async function loadSwitcher() {
  const sel = $("#projSwitch");
  const ps = await fetch("/api/projects").then((r) => r.json()).catch(() => []);
  sel.replaceChildren(...ps.map((p) => el("option", { value: p.project_id, selected: p.project_id === ID }, (p.has_timeline ? "✂ " : "") + (p.title || p.project_id))));
  sel.onchange = () => { location.href = `/e/${encodeURIComponent(sel.value)}`; };
}

// ---------------------------------------------------------------------------
// Media bin
// ---------------------------------------------------------------------------
const LOOSE = "Loose files";
const binPath = (m) => { const f = m.folder || ""; return f === "media" ? "" : f.startsWith("media/") ? f.slice(6) : f; };   // folder shown in the bin: public/media/<this>
const binTop = (m) => binPath(m).split("/")[0] || LOOSE;
const FOLDER_ICO = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const icon = (svg) => { const i = el("span", { class: "fdd-ico" }); i.innerHTML = svg; return i; };
// Media folder picker: a button that opens a list of folders with their file counts (the selected one is ticked).
const fmtBytes = (n) => !n ? "" : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
const fmtDate = (t) => t ? new Date(t * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
const SORTS = [["name", "Name"], ["size", "Size"], ["date", "Date created"]];
const saveBinPrefs = () => { try { localStorage.setItem("montage-bin-prefs", JSON.stringify({ v: S.binView, s: S.binSort, d: S.binDir })); } catch { /* storage blocked */ } };
try { const p = JSON.parse(localStorage.getItem("montage-bin-prefs") || "{}"); S.binView = p.v || "grid"; S.binSort = p.s || "name"; S.binDir = p.d || "asc"; } catch { /* ignore */ }
// Under the folder picker: folder title and file count, how to sort, and thumbnails or a list.
function binToolbar(title, n) {
  const sel = el("select", { class: "bt-sort", title: "Sort by", onchange: (e) => { S.binSort = e.target.value; saveBinPrefs(); renderBin(); } },
    ...SORTS.map(([v, l]) => el("option", { value: v, selected: S.binSort === v }, l)));
  return el("div", { class: "fdd-title" },
    el("span", { class: "bt-name" }, title, el("small", { class: "bt-count" }, ` · ${n} files`)),
    el("span", { class: "bt-tools" },
      el("button", { class: `bt-btn${S.favOnly ? " on" : ""}`, title: S.favOnly ? "Showing favorites only (click to show all)" : "Show only my favorites", onclick: () => { S.favOnly = !S.favOnly; renderBin(); } }, `♥ ${S.favs.size}`),
      sel,
      el("button", { class: "bt-btn", title: S.binDir === "desc" ? "Biggest or newest first (click to reverse)" : "Smallest or oldest first (click to reverse)", onclick: () => { S.binDir = S.binDir === "desc" ? "asc" : "desc"; saveBinPrefs(); renderBin(); } }, S.binDir === "desc" ? "↓" : "↑"),
      el("button", { class: `bt-btn${S.binView === "grid" ? " on" : ""}`, title: "Thumbnails", onclick: () => { S.binView = "grid"; saveBinPrefs(); renderBin(); } }, "▦"),
      el("button", { class: `bt-btn${S.binView === "small" ? " on" : ""}`, title: "Small thumbnails (more on screen)", onclick: () => { S.binView = "small"; saveBinPrefs(); renderBin(); } }, "▪▪"),
      el("button", { class: `bt-btn${S.binView === "list" ? " on" : ""}`, title: "List", onclick: () => { S.binView = "list"; saveBinPrefs(); renderBin(); } }, "☰")));
}
const folderLabel = (f) => {
  if (f === "all") return "All media";
  const parts = f.split("/"), clash = S.media.some((m) => binFolder(m) !== f && binFolder(m).split("/").pop().replace(/^\d+_|^_+/, "") === parts[parts.length - 1].replace(/^\d+_|^_+/, ""));
  const last = parts[parts.length - 1];
  if (last === "fx") return "Background effects";
  const t = last.replace(/^\d+_/, "").replace(/^_+/, "").replace(/[_-]+/g, " ").trim();
  const name = t ? t[0].toUpperCase() + t.slice(1) : last;
  return clash && parts.length > 1 ? `${folderLabel(parts.slice(0, -1).join("/"))} / ${name}` : name;
};
async function removeFile(m) {
  if (!confirm(`Remove "${m.name}" from this project?\n\nIt moves to the project's trash folder, and Refresh will not bring it back. Your original file outside the project is not touched.`)) return;
  try {
    await api("/media/remove", { method: "POST", body: JSON.stringify({ src: m.src }) });
    S.favs.delete(m.src); await loadMedia(); toast(`Removed "${m.name}"`);
  } catch (e) { toast(e.message); }
}
const trashBtn = (m) => el("button", { class: "rm-file", title: "Remove from this project (moved to the trash folder)", onclick: (e) => { e.stopPropagation(); removeFile(m); } }, "🗑");
async function removeFolder(f, label, n) {
  if (!confirm(`Remove the folder "${label}" (${n} file${n === 1 ? "" : "s"}) from this project?\n\nIt is moved to the project's trash folder, not erased, and Refresh will not bring it back. Your original files outside the project are not touched.`)) return;
  try {
    const r = await api("/folder/remove", { method: "POST", body: JSON.stringify({ folder: f }) });
    S.fddOpen = false; if (S.binTab === f) S.binTab = "all";
    await loadMedia();
    toast(`Removed "${label}" (${r.files} file${r.files === 1 ? "" : "s"}). Kept in ${r.kept_in}`);
  } catch (e) { toast(e.message); }
}
function folderPicker(tops) {
  const special = { [BANK_TAB]: "Cuts Bank", [MOTION_TAB]: "Motion", [BOARD_TAB]: "Inspiration" }[S.binTab];
  const count = (f) => S.media.filter((m) => f === "all" || binFolder(m) === f).length;
  const name = special || folderLabel(S.binTab);
  const open = !!S.fddOpen;
  const pick = (f) => { S.fddOpen = false; S.binTab = f; renderBin(); };
  const row = (f, label) => el("div", { class: `fdd-row${S.binTab === f ? " on" : ""}`, title: f, onclick: (e) => { e.stopPropagation(); pick(f); } },
    icon(FOLDER_ICO), el("span", { class: "fdd-name" }, label), el("span", { class: "fdd-n" }, String(count(f))), S.binTab === f ? el("span", { class: "fdd-ck" }, "✓") : null,
    f === "all" || f === LOOSE ? null : el("button", { class: "fdd-x", title: "Remove this folder from the project (your original files stay where they are)", onclick: (e) => { e.stopPropagation(); removeFolder(f, label, count(f)); } }, "🗑"));
  return el("div", { class: "fdd" },
    el("label", {}, "Media folder"),
    el("button", { class: `fdd-trigger${open ? " open" : ""}`, type: "button", onclick: (e) => { e.stopPropagation(); S.fddOpen = !S.fddOpen; renderBin(); } },
      icon(FOLDER_ICO),
      el("span", { class: "fdd-txt" }, el("b", {}, name), el("small", {}, special ? "special panel" : `${count(S.binTab)} clips`)),
      el("span", { class: "fdd-chev" }, open ? "⌃" : "⌄")),
    open ? el("div", { class: "fdd-list" }, row("all", "All media"), ...tops.map((f) => row(f, folderLabel(f)))) : "");
}
document.addEventListener("click", () => { if (S.fddOpen) { S.fddOpen = false; renderBin(); } });
const binFolder = (m) => binPath(m) || LOOSE;
const inTab = (m) => S.binTab === "all" || binFolder(m) === S.binTab;
function renderBin() {
  const tops = [...new Set(S.media.map(binFolder))].sort((a, b) => (a === LOOSE) - (b === LOOSE) || a.localeCompare(b));
  if (S.binTab !== "all" && S.binTab !== MOTION_TAB && S.binTab !== BOARD_TAB && S.binTab !== BANK_TAB && !tops.includes(S.binTab)) S.binTab = "all";
  $("#binTabs").replaceChildren(
    el("button", { class: "imp-btn", title: "Import photos/videos", onclick: openImporter }, "＋ Import"),
    el("button", { class: "ghost", title: "Bring in new files from the original folders (Finder, downloads) and reload the list", onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try {
        const sync = await api("/sync-links", { method: "POST" }).catch(() => ({ added: 0, folders: {}, missing: [], linked: 0 }));
        const before = S.media.length; await loadMedia(); const d = S.media.length - before;
        const where = Object.keys(sync.folders).join(", ");
        toast(sync.added ? `${sync.added} new file${sync.added > 1 ? "s" : ""} brought in from ${where}` : d > 0 ? `${d} new file${d > 1 ? "s" : ""} found` : d < 0 ? `${-d} file${d < -1 ? "s" : ""} removed` : sync.missing.length ? `Original folder not found: ${sync.missing.join(", ")}` : "Media folder is up to date");
      } finally { b.disabled = false; }
    } }, "↻ Refresh"),
    S.bank.cuts.length ? el("button", { class: S.binTab === BANK_TAB ? "on" : "", title: "Ready-made cuts of what customers say. Each one points into the original video, so you can extend it on the timeline.", onclick: () => { S.binTab = BANK_TAB; renderBin(); } }, "✂ Cuts Bank") : "",
    el("button", { class: S.binTab === MOTION_TAB ? "on" : "", onclick: () => { S.binTab = MOTION_TAB; renderBin(); } }, "✨ Motion"),
    );
  $("#binFolder").replaceChildren(folderPicker(tops));
  $("#binSearch").classList.toggle("hidden", S.binTab === BANK_TAB || S.binTab === MOTION_TAB || S.binTab === BOARD_TAB || !S.bank.cuts.length);
  if (S.binTab === BANK_TAB) {
    const a = document.activeElement;
    if (a && $("#binGrid").contains(a) && ["INPUT"].includes(a.tagName)) return;   // do not rebuild while you type in the search box
    $("#binGrid").classList.add("motion"); $("#binGrid").classList.remove("list");
    return $("#binGrid").replaceChildren(bankPanel());
  }
  if (S.binTab === BOARD_TAB) {
    const a = document.activeElement;
    if (a && $("#binGrid").contains(a) && ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName)) return;   // never rebuild while you type a note
    $("#binGrid").classList.add("motion");
    return $("#binGrid").replaceChildren(boardPanel());
  }
  if (S.binTab === MOTION_TAB) {
    const a = document.activeElement;
    if (a && $("#binGrid").contains(a) && ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName)) return;
    $("#binGrid").classList.add("motion");
    return $("#binGrid").replaceChildren(motionPanel());
  }
  $("#binGrid").classList.remove("motion");
  const q = (S.binQ || "").trim();
  if (q) {
    const names = S.media.filter((m) => inTab(m) && (!S.favOnly || S.favs.has(m.src)) && m.name.toLowerCase().includes(q.toLowerCase()));
    const used2 = new Set((S.tl?.clips || []).map((c) => c.src));
    const nodes = [el("div", { class: "bin-sec" }, el("span", {}, "✂ Cuts Bank, closest first"), el("span", { class: "n" }, String(S.binHits.length)))];
    nodes.push(...(S.binHits.length ? S.binHits.map((c) => bankRow(c, c.score)) : [el("div", { class: "hint", style: { gridColumn: "1 / -1" } }, "No cut says anything close to that.")]));
    if (names.length) {
      nodes.push(el("div", { class: "bin-sec" }, el("span", {}, "Files with that name"), el("span", { class: "n" }, String(names.length))));
      nodes.push(...names.map((m) => el("div", { class: "card", draggable: "true", title: m.src, onclick: () => previewMedia(m),
        ondragstart: (e) => { e.dataTransfer.setData("text/montage-src", m.src); e.dataTransfer.effectAllowed = "copy"; } },
        m.kind === "audio" ? el("div", { class: "audio-ico" }, "♫") : el("img", { src: thumbUrl(m.src), loading: "lazy" }),
        used2.has(m.src) ? el("div", { class: "used" }, "IN") : null,
        el("div", { class: "add", title: "Add to the timeline", onclick: (e) => { e.stopPropagation(); addMedia(m); } }, "+"),
        el("div", { class: "meta" }, el("span", {}, m.name), el("span", {}, m.kind === "image" ? "📷" : m.duration ? fmt(m.duration) : "")))));
    }
    return $("#binGrid").replaceChildren(...nodes);
  }
  const used = new Set((S.tl?.clips || []).map((c) => c.src).concat(S.tl?.music ? [S.tl.music.src] : []).concat((S.tl?.music_more || []).map((m) => m.src)));
  const items = S.media.filter((m) => inTab(m) && (!S.favOnly || S.favs.has(m.src)));
  const makeCard = (m) => {
    const card = el("div", { class: "card", draggable: "true", title: m.src,
      onclick: () => previewMedia(m),
      ondragstart: (e) => { e.dataTransfer.setData("text/montage-src", m.src); e.dataTransfer.effectAllowed = "copy"; } },
      m.kind === "audio" ? el("div", { class: "audio-ico" }, "♫") : el("img", { src: thumbUrl(m.src), loading: "lazy" }),
      heartBtn(m), trashBtn(m),
      used.has(m.src) ? el("div", { class: "used" }, "IN") : null,
      el("div", { class: "add", title: "Add to the timeline", onclick: (e) => { e.stopPropagation(); addMedia(m); } }, "+"),
      el("div", { class: "meta" }, el("span", {}, m.name), el("span", {}, m.kind === "image" ? "📷" : m.duration ? fmt(m.duration) : "")));
    return card;
  };
  const makeRow = (m) => el("div", { class: "card-row", draggable: "true", title: m.src, onclick: () => previewMedia(m),
      ondragstart: (e) => { e.dataTransfer.setData("text/montage-src", m.src); e.dataTransfer.effectAllowed = "copy"; } },
    m.kind === "audio" ? el("div", { class: "audio-ico" }, "♫") : el("img", { src: thumbUrl(m.src), loading: "lazy" }),
    el("div", { class: "cr-main" }, el("b", {}, m.name), el("small", {}, `${m.kind === "image" ? "photo" : fmt(m.duration || 0)} · ${fmtBytes(m.bytes)} · ${fmtDate(m.created)}`)),
    used.has(m.src) ? el("span", { class: "cr-in" }, "IN") : null,
    heartBtn(m), trashBtn(m),
    el("button", { class: "cr-add", title: "Add to the timeline", onclick: (e) => { e.stopPropagation(); addMedia(m); } }, "+"));
  const sortKey = { name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }), size: (a, b) => (a.bytes || 0) - (b.bytes || 0), date: (a, b) => (a.created || 0) - (b.created || 0) }[S.binSort] || (() => 0);
  const dir = S.binDir === "desc" ? -1 : 1;
  const sorted = (l) => [...l].sort((a, b) => dir * sortKey(a, b));
  const asList = S.binView === "list";
  $("#binGrid").classList.toggle("list", asList);
  $("#binGrid").classList.toggle("small", S.binView === "small");
  // Group by sub-folder so "cut clips", "b-roll" ... stay apart, like they are on disk.
  const groups = new Map();
  for (const m of items) { const k = binPath(m) || LOOSE; (groups.get(k) || groups.set(k, []).get(k)).push(m); }
  const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const nodes = [];
  nodes.push(binToolbar(S.binTab === "all" ? "All media" : folderLabel(S.binTab), items.length));
  for (const k of keys) {
    const list = groups.get(k), shut = S.binShut.has(k);
    if (!(keys.length === 1 && S.binTab !== "all")) {
      const label = S.binTab !== "all" && k.startsWith(S.binTab + "/") ? k.slice(S.binTab.length + 1) : k === S.binTab ? "Main folder" : k;
      nodes.push(el("div", { class: "bin-sec", title: k, onclick: () => { shut ? S.binShut.delete(k) : S.binShut.add(k); renderBin(); } },
        el("span", {}, `${shut ? "▸" : "▾"} ${label}`), el("span", { class: "n" }, String(list.length))));
    }
    if (!shut) nodes.push(...sorted(list).map(asList ? makeRow : makeCard));
  }
  $("#binGrid").replaceChildren(...nodes);
}
// ---------------------------------------------------------------------------
// Cuts Bank: cuts of what customers say. Each one is a window into an ORIGINAL video (public/media/cuts-bank/_sources),
// so when it is on the timeline its edges can be dragged out to use more of the original, like any other clip.
// The list lives in public/media/cuts-bank/bank.json.
// ---------------------------------------------------------------------------
const BANK_TAB = "__bank";
async function loadBank() {
  try { const r = await fetch(MEDIA_BASE + "media/cuts-bank/bank.json", { cache: "no-store" }); S.bank.cuts = r.ok ? (await r.json()).cuts || [] : []; }
  catch { S.bank.cuts = []; }
}
function bankMedia(c) { return { src: c.rel, name: c.name, kind: "video", duration: c.duration, width: c.width, height: c.height, has_audio: c.has_audio, _cut: { in: c.in, out: c.out } }; }
function bankById(id) { const c = S.bank.cuts.find((x) => x.id === id); return c ? bankMedia(c) : null; }
function bankRow(c, score) {
  return el("div", { class: "bank-row", draggable: "true",
    ondragstart: (e) => { e.dataTransfer.setData("text/montage-src", "bank:" + c.id); e.dataTransfer.effectAllowed = "copy"; } },
    el("div", { class: "bank-top" }, el("b", {}, c.name), el("span", { class: "bank-len" }, (score != null ? Math.round(score * 100) + "% · " : "") + fmt(c.len)),
      el("button", { title: "Play this cut", onclick: () => previewMedia(bankMedia(c)) }, "▶"),
      el("button", { class: "primary", title: "Add to the timeline. Drag its edges out to use more of the original video.", onclick: () => addMedia(bankMedia(c)) }, "＋")),
    el("div", { class: "bank-q" }, "\u201C" + c.text + "\u201D"),
    [c.sub, ...(c.flags || [])].filter(Boolean).length ? el("div", { class: "bank-flags" }, [c.sub, ...(c.flags || [])].filter(Boolean).join(" · ")) : null);
}
function bankPanel() {
  const cats = ["All", ...new Set(S.bank.cuts.map((c) => c.cat))];
  const list = el("div", { class: "bank-list" });
  let seq = 0;
  const show = (rows, scored) => { list.replaceChildren(...(rows.length ? rows.map((c) => bankRow(c, scored ? c.score : null)) : [el("div", { class: "hint" }, "No cuts match.")])); count.textContent = `${rows.length} cuts`; };
  const draw = async () => {
    const q = (S.bank.q || "").trim(), mine = ++seq;
    if (!q) return show(S.bank.cuts.filter((c) => S.bank.cat === "All" || c.cat === S.bank.cat), false);
    try { const r = await api(`/library-search?q=${encodeURIComponent(q)}&cat=${encodeURIComponent(S.bank.cat)}`); if (mine === seq) show(r.cuts, true); }   // loose match: typos and half-remembered words still find it
    catch { if (mine === seq) show([], false); }
  };
  const count = el("span", { class: "bank-count" });
  const box = el("div", { class: "bank" },
    el("div", { class: "hint" }, "Each cut points into the original video. Add it, then drag the clip's edges on the timeline to use more before or after."),
    chips(cats, S.bank.cat, (v) => { S.bank.cat = v; renderBin(); }),
    el("div", { class: "bank-search" }, el("input", { placeholder: "Search what they say or who...", value: S.bank.q, oninput: (e) => { S.bank.q = e.target.value; draw(); } }), count),
    list);
  draw();
  return box;
}
// ---------------------------------------------------------------------------
// Motion scenes (HyperFrames templates -> animated clip)
// ---------------------------------------------------------------------------
const MOTION_TAB = "__motion";
async function loadTemplates() { S.motion.templates = (await api("/motion/templates")).templates; }
const tplById = (id) => S.motion.templates.find((t) => t.id === id);

// One form for both "new scene" (bin) and "edit scene" (inspector).
function sceneForm(tpl, values, seconds, onChange, onSubmit, submitLabel) {
  const images = S.media.filter((m) => m.kind === "image");
  const fields = tpl.fields.map((f) => {
    const v = values[f.id] ?? f.default ?? "";
    if (f.type === "color") return field(f.label, el("input", { type: "color", value: v, onchange: (e) => onChange(f.id, e.target.value) }));
    if (f.type === "photo") {
      const opts = [""].concat(images.map((m) => m.src));
      // When re-editing, the value is just a file name copied into the scene; show it as-is.
      if (v && !opts.includes(v)) opts.push(v);
      return field(f.label, select(opts, v, (x) => onChange(f.id, x), opts.map((o) => (o ? o.split("/").pop() : "— none —"))));
    }
    return field(f.label, el("input", { type: "text", value: v, dir: "auto", oninput: (e) => onChange(f.id, e.target.value) }));
  });
  const busy = S.motion.job?.running;
  return el("div", { class: "motion-form" },
    ...fields,
    field("Seconds", num(seconds, (x) => onChange("__seconds", x), { min: "1", max: "15" })),
    el("button", { class: "primary", disabled: busy, onclick: onSubmit }, busy ? "Rendering…" : submitLabel),
    S.motion.job?.error ? el("div", { class: "hint err" }, S.motion.job.error) : null);
}
function motionPanel() {
  const M = S.motion;
  if (!M.tpl) {
    return el("div", { class: "motion-list" },
      el("div", { class: "hint" }, "Pick an animated scene. It is made with HyperFrames and added to the timeline as a clip."),
      ...M.templates.map((t) => el("div", { class: "tpl", onclick: () => {
        M.tpl = t.id; M.values = Object.fromEntries(t.fields.map((f) => [f.id, f.default ?? ""])); M.seconds = t.default_seconds; renderBin();
      } }, el("b", {}, t.label), el("span", {}, t.description))));
  }
  const tpl = tplById(M.tpl);
  return el("div", {},
    el("button", { class: "ghost back-tpl", onclick: () => { M.tpl = null; renderBin(); } }, "← All scenes"),
    el("h3", {}, tpl.label),
    sceneForm(tpl, M.values, M.seconds,
      (k, v) => { if (k === "__seconds") M.seconds = v; else M.values[k] = v; },
      () => renderMotion({ template: tpl.id, params: M.values, seconds: M.seconds }, null),
      "Create & render"));
}
// Start a render and wait for it. `clipId` = existing clip to update (re-render), else a new clip is inserted.
async function renderMotion(body, clipId) {
  if (S.dirty) await save();
  try { S.motion.job = await api("/motion/render", { method: "POST", body: JSON.stringify(body) }); }
  catch (e) { toast(e.message); return; }
  renderBin(); renderInspector(true);
  while (S.motion.job?.running) {
    await new Promise((r) => setTimeout(r, 1200));
    S.motion.job = await api("/motion/render").catch(() => S.motion.job);
  }
  const job = S.motion.job;
  renderBin(); renderInspector(true);
  if (!job.ok) { toast("Scene failed"); return; }
  // The preview player may keep the old file for the same path; bump a cache-buster via a fresh media list.
  await loadMedia();
  if (clipId) {
    commit((tl) => {
      const c = tl.clips.find((x) => x.id === clipId); if (!c) return;
      const n = job.clip;
      Object.assign(c, { src: n.src, in: n.in, out: n.out, source_duration: n.source_duration, generated: n.generated });
    });
    S.motion.edit = null;
    toast("Scene updated");
  } else {
    const clip = { ...job.clip, id: newId() };
    commit((tl) => {
      const i = S.sel?.t === "clip" ? clipIndex(S.sel.id) + 1 : tl.clips.length;
      tl.clips.splice(i, 0, clip);
    });
    S.sel = { t: "clip", id: clip.id }; renderAll();
    const it = lay().items.find((x) => x.clip.id === clip.id); if (it) seek(it.start + 0.01);
    toast("Scene added");
  }
}
function motionInspector(c) {
  const g = c.generated, tpl = tplById(g.template);
  if (!tpl) return el("div", { class: "hint" }, `Unknown template: ${g.template}`);
  // The inspector keeps its own values, separate from the "new scene" form in the bin.
  const M = S.motion;
  if (M.edit?.clip !== c.id) M.edit = { clip: c.id, values: { ...g.params }, seconds: r3(clipLen(c)) };
  const E = M.edit;
  return el("div", { class: "sec" }, el("div", { class: "sec-t" }, `Motion scene · ${tpl.label}`),
    sceneForm(tpl, E.values, E.seconds,
      (k, v) => { if (k === "__seconds") E.seconds = v; else E.values[k] = v; },
      () => renderMotion({ template: g.template, scene: g.scene, params: E.values, seconds: E.seconds }, c.id),
      "Re-render scene"));
}

function clipFromMedia(m) {
  const dim = m.width && m.height ? { dim: [m.width, m.height] } : {};
  if (m.kind === "image") return { ...dim, id: newId(), src: m.src, kind: "image", label: m.name.replace(/\.[^.]+$/, ""), hold: 2.5, fit: "cover", motion: "zoom-in", transition: { type: "fade", seconds: 0.3 } };
  const d = m.duration || 3;
  const win = m._cut ? m._cut.out - m._cut.in : Math.min(3, d); const a = m._cut ? m._cut.in : Math.max(0, (d - win) / 2);   // a Cuts Bank cut keeps its own in/out; the clip still knows the whole source, so its edges can be dragged out
  return { ...dim, id: newId(), src: m.src, kind: "video", label: m.name.replace(/\.[^.]+$/, ""), in: r3(a), out: r3(a + win), source_duration: r3(d), speed: 1, volume: m.has_audio ? 1 : 0, fit: "cover", motion: "punch", transition: { type: "flash", seconds: 0.3 } };
}
// Click a bin item: look at it in the stage first (play it, scrub it); "Add to timeline" is explicit.
function closePreview() { $("#mediaPreview")?.querySelector("video,audio")?.pause?.(); $("#mediaPreview")?.remove(); }
function previewMedia(m) {
  closePreview();
  const url = MEDIA_BASE + m.src.split("/").map(encodeURIComponent).join("/") + (m._cut ? `#t=${m._cut.in},${m._cut.out}` : "");
  player?.pause?.();
  const body = m.kind === "image" ? el("img", { src: url })
    : m.kind === "audio" ? el("audio", { src: url, controls: "", autoplay: "" })
    : el("video", { src: url, controls: "", autoplay: "", loop: "", playsinline: "" });
  $("#stage").appendChild(el("div", { id: "mediaPreview" },
    el("div", { class: "mp-head" }, el("span", {}, `${m.name}${m.duration ? " · " + fmt(m.duration) : ""}`),
      el("div", { class: "btns" },
        el("select", { id: "mpWhere", title: "Which channel to add it to", style: { width: "auto" } },
          ...(m.kind === "audio" ? [["m1", "Music 1"], ["m2", "Music 2"], ["m3", "Music 3"]] : [["v1", "Video 1 (main)"], ["v2", "Video 2"], ["v3", "Video 3"]]).map(([v, t]) => el("option", { value: v }, t))),
        el("button", { class: "primary", onclick: () => { const w = $("#mpWhere")?.value || "v1"; closePreview(); addMediaTo(m, w); } }, "＋ Add at playhead"),
        el("button", { onclick: closePreview }, "✕ Close"))),
    el("div", { class: "mp-body" }, body)));
}
function addMedia(m, atIndex = null) {
  if (m.kind === "audio" && binPath(m).startsWith("sound-effects")) { addMediaTo(m, "m2"); return; }   // a sound effect goes in at the playhead on Music 2, never over the song
  if (m.kind === "audio") {
    if (S.sel?.t === "music" && selMusic() > 0 && musicAt(S.tl, selMusic())) { const i = selMusic(); commit((tl) => { musicAt(tl, i).src = m.src; musicAt(tl, i).offset = 0; }); renderAll(); toast("Song changed for this piece"); return; }
    commit((tl) => { tl.music = { src: m.src, offset: 0, volume: 1, duck_volume: 0.25, fade_in: 0.5, fade_out: 2, start_at: "clips" }; });
    S.sel = { t: "music", i: 0 }; renderAll(); toast("Music set"); return;
  }
  const clip = clipFromMedia(m);
  commit((tl) => {
    let i = atIndex;
    if (i == null) i = S.sel?.t === "clip" ? clipIndex(S.sel.id) + 1 : tl.clips.length;
    tl.clips.splice(i, 0, clip);
  });
  S.sel = { t: "clip", id: clip.id }; renderAll();
  const it = lay().items.find((x) => x.clip.id === clip.id); if (it) seek(it.start + 0.01);
}

// ---------------------------------------------------------------------------
// Player + transport
// ---------------------------------------------------------------------------
function seek(t) { S.time = clamp(t, 0, lay().total); player?.seek(S.time); renderPlayhead(); }
function renderTime() { $("#time").textContent = `${tc(S.time)} / ${tc(lay().total)}`; }
function onTime(t) { S.time = t; requestAnimationFrame(renderPlayhead); }
function renderPlayhead() {
  $("#playhead").style.left = `${S.time * S.pps}px`;
  $("#phTime").textContent = tc(S.time);
  renderDbRead(); moveSoundHead();
  if (xformKey() !== S.xfKey) { renderRulers(); renderXform(); }       // the box shows only while the playhead is inside the selected clip
  renderTime();
  // Keep the playhead visible while playing, but never fight the user: after they scroll, leave the view alone.
  if (S.playing && Date.now() - (S.userScrollAt || 0) > 4000) {
    const sc = $("#tlScroll"), x = S.time * S.pps;
    if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - 80;
  }
}
// ---------------------------------------------------------------------------
// Sound panel: a close-up of the selected clip with its sound, and the music and other channels under it, all on one time scale.
// Click a channel to work on it: add keyframes on its volume line (a precise list below), fade in and out.
// ---------------------------------------------------------------------------
S.snd = { focus: null };
function sndWindow() {
  const L = lay(), op = L.openerSeconds;
  if (S.sel?.t === "layer") { const l = (S.tl.layers || []).find((x) => x.id === S.sel.id); if (l) return { a: op + l.start, b: op + l.end, title: `Video ${l.lane}: ${l.label || l.src.split("/").pop()}`, src: l.src, kind: "layer", id: l.id }; }
  let it = S.sel?.t === "clip" ? L.items.find((x) => x.clip.id === S.sel.id) : null;
  if (!it) it = L.items.find((x) => !x.isOpener && S.time >= x.start && S.time < x.start + x.duration);
  if (!it || it.isOpener) return null;
  return { a: it.start, b: it.start + it.duration, title: `Video 1: ${it.clip.label || it.clip.src.split("/").pop()}`, src: it.clip.src, kind: "clip", id: it.clip.id };
}
// Every channel that makes sound inside the window [a, b] (seconds on the movie clock).
function sndChannels(win) {
  const L = lay(), op = L.openerSeconds, out = [];
  const near = (start, dur) => start < win.b - 1e-6 && start + dur > win.a + 1e-6;
  const it = L.items.find((x) => x.clip.id === win.id && win.kind === "clip");
  if (win.kind === "clip" && it && it.clip.kind === "video") out.push({ k: { kind: "clip", id: it.clip.id }, title: "Clip sound", sub: win.title, obj: it.clip, start: it.start, dur: it.duration, src: it.clip.src, srcAt: (t) => (it.clip.in ?? 0) + t * (it.clip.speed || 1), speed: it.clip.speed || 1, dflt: 0 });
  const lay23 = (S.tl.layers || []).filter((l) => l.kind === "video" && !(win.kind === "layer" && win.id === l.id) && near(op + l.start, l.end - l.start));
  if (win.kind === "layer") { const l = S.tl.layers.find((x) => x.id === win.id); if (l.kind === "video") out.push({ k: { kind: "layer", id: l.id }, title: "Clip sound", sub: win.title, obj: l, start: op + l.start, dur: l.end - l.start, src: l.src, srcAt: (t) => (l.in ?? 0) + t * (l.speed || 1), speed: l.speed || 1, dflt: 0 }); }
  for (let i = 0; i < musicCount(S.tl); i++) {
    const m = musicAt(S.tl, i), sp = musicSpan(S.tl, i);
    if (near(op + sp.start, sp.end - sp.start)) out.push({ k: { kind: "music", i }, title: `Music ${laneOf(m)}`, sub: m.src.split("/").pop().replace(/\.[^.]+$/, ""), obj: m, start: op + sp.start, dur: sp.end - sp.start, src: m.src, srcAt: (t) => (m.offset ?? 0) + t, speed: 1, dflt: 0.8 });
  }
  for (const l of lay23) out.push({ k: { kind: "layer", id: l.id }, title: `Video ${l.lane} sound`, sub: l.label || l.src.split("/").pop(), obj: l, start: op + l.start, dur: l.end - l.start, src: l.src, srcAt: (t) => (l.in ?? 0) + t * (l.speed || 1), speed: l.speed || 1, dflt: 0 });
  return out;
}
const chanKey = (k) => `${k.kind}:${k.id ?? k.i}`;
function chanLevel(ch, absT) {
  const t = absT - ch.start; if (t < 0 || t > ch.dur) return "";
  const base = peakDb(ch.src, ch.srcAt(t)), vol = ch.obj.volume ?? ch.dflt;
  if (!(vol > 0)) return "muted";
  const d = base == null ? null : base + 20 * Math.log10(vol) + lineDb(ch.obj.vol, t);
  return d == null || d < -60 ? "silent" : `${d.toFixed(1)} dB`;
}
function sndAddKey(ch, atItemT, db) {
  commit((tl) => {
    const o = volObj(tl, ch.k); o.vol = o.vol || [];
    const t = r3(clamp(atItemT, 0, ch.dur)), cur = db ?? Math.round(lineDb(o.vol, t) * 2) / 2;
    const at = o.vol.findIndex((p) => p.t >= t);
    if (at >= 0 && Math.abs(o.vol[at].t - t) < 0.02) o.vol[at].db = cur; else o.vol.splice(at < 0 ? o.vol.length : at, 0, { t, db: cur });
  });
}
function sndFade(ch, dir, secs) {
  commit((tl) => {
    const o = volObj(tl, ch.k), at = (t) => lineDb(o.vol, t), d = Math.min(secs, ch.dur / 2);
    const pts = [...(o.vol || [])];
    const put = (t, db) => { t = r3(t); const i = pts.findIndex((p) => Math.abs(p.t - t) < 0.02); if (i >= 0) pts[i].db = db; else pts.push({ t, db }); };
    if (dir === "in") { const to = at(d); put(0, DB_MIN); put(d, to); } else { const from = at(ch.dur - d); put(ch.dur - d, from); put(ch.dur, DB_MIN); }
    o.vol = pts.sort((a, b) => a.t - b.t);
  });
}
// Master level: all the channels added together at the playhead (estimate from the 20-a-second loudness), with ducking and the master fader.
function masterDb() {
  const L = lay(), tl = S.tl, mas = tl.master_db || 0, tr = tl.tracks || {};
  const lin = (d) => (d == null || d === -Infinity ? 0 : Math.pow(10, d / 20));
  let sum = 0, clipLoud = false;
  const it = L.items.find((x) => !x.isOpener && S.time >= x.start && S.time < x.start + x.duration);
  if (it && it.clip.kind === "video" && !tr.v1?.mute && it.clip.volume > 0 && mediaInfo(it.clip.src)?.has_audio !== false) {
    const c = it.clip, off = S.time - it.start, b = peakDb(c.src, (c.in ?? 0) + off * (c.speed || 1));
    sum += lin(b == null ? null : b + 20 * Math.log10(c.volume) + lineDb(c.vol, off)); clipLoud = true;
  }
  for (const l of tl.layers || []) {
    const t = S.time - L.openerSeconds - l.start;
    if (l.kind !== "video" || tr["v" + l.lane]?.mute || !(l.volume > 0) || t < 0 || t > l.end - l.start) continue;
    const b = peakDb(l.src, (l.in ?? 0) + t * (l.speed || 1)); sum += lin(b == null ? null : b + 20 * Math.log10(l.volume) + lineDb(l.vol, t));
  }
  for (let i = 0; i < musicCount(tl); i++) {
    const mm = musicAt(tl, i), sp = musicSpan(tl, i), t = S.time - L.openerSeconds - sp.start;
    if (tr["m" + laneOf(mm)]?.mute || t < 0 || t > sp.end - sp.start) continue;
    const base = mm.volume ?? 0.8, vol = clipLoud ? Math.min(base, mm.duck_volume ?? 0.25) : base;
    const b = peakDb(mm.src, (mm.offset ?? 0) + t); sum += lin(b == null ? null : b + 20 * Math.log10(Math.max(vol, 1e-6)) + lineDb(mm.vol, t));
  }
  return sum > 0 ? 20 * Math.log10(sum) + mas : -Infinity;
}
function drawMeter() {
  const box = document.querySelector("#sound .meter"); if (!box) return;
  const db = masterDb(), fr = (d) => clamp((d + 60) / 60, 0, 1);
  const pk = S.snd.peak = S.playing || !S.snd.peak ? Math.max(db, (S.snd.peak ?? -Infinity) - 0.6) : db;      // peak hold falls slowly
  box.querySelectorAll(".mbar i").forEach((b) => { b.style.height = (1 - fr(db)) * 100 + "%"; });
  box.querySelectorAll(".mbar u").forEach((b) => { b.style.bottom = fr(pk) * 100 + "%"; });
  box.querySelector(".mread").textContent = db === -Infinity || db < -60 ? "-∞" : db.toFixed(1);
}

function renderSound() {
  const box = $("#sound"); if (!box || box.classList.contains("hidden") || !S.tl) return;
  const win = sndWindow();
  const head = el("div", { class: "snd-head" }, el("b", {}, "🎚 Sound"), el("span", { class: "grow" }), el("button", { onclick: () => setPanel("snd", false) }, "Close"));
  if (!win) { box.replaceChildren(head, el("div", { class: "hint" }, "Click a video clip on the timeline (or park the playhead on one) to see its sound here, with the music and other channels under it.")); return; }
  const W = Math.round(S.sndW - 32), dur = win.b - win.a, chans = sndChannels(win);
  if (!chans.some((c) => chanKey(c.k) === S.snd.focus)) S.snd.focus = chans[0] ? chanKey(chans[0].k) : null;
  const ph = () => el("div", { class: "snd-ph", "data-a": win.a, "data-d": dur });
  const scrub = (e) => { const r = e.currentTarget.getBoundingClientRect(); const go = (x) => seek(win.a + clamp((x - r.left) / r.width, 0, 1) * dur); go(e.clientX); const mv = (ev) => go(ev.clientX), up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); };
  const closeUp = el("div", { class: "snd-video", style: { backgroundImage: `url("${thumbUrl(win.src)}")` }, title: "Drag to move the playhead", onpointerdown: scrub }, el("div", { class: "snd-cap" }, `${win.title}  ·  ${tc(dur)}`), ph());
  const rows = chans.map((ch) => {
    const key = chanKey(ch.k), focus = key === S.snd.focus, t0 = win.a - ch.start, w = el("div", { class: "snd-wave" });
    const muted = !((ch.obj.volume ?? ch.dflt) > 0);
    w.append(waveCanvas(ch.src, ch.srcAt(t0), dur * ch.speed, W, false, 96, gainOf(ch.obj, ch.dflt, (f) => t0 + f * dur)),
      ...[0, -10, -20, -30].map((db) => el("div", { class: "dbline", style: { top: dbToY(db) * 100 + "%" } }, el("span", {}, db + " dB"))),
      volOverlay(ch.k, ch.obj, ch.dur, t0, dur), ph());
    const row = el("div", { class: "snd-row" + (focus ? " focus" : "") },
      el("div", { class: "snd-rh" }, el("b", {}, ch.title), el("span", { class: "sub" }, ch.sub), el("span", { class: "grow" }), el("span", { class: "lvl", "data-ch": key }, chanLevel(ch, S.time))), w);
    row.addEventListener("pointerdown", () => { if (S.snd.focus !== key) { S.snd.focus = key; setTimeout(renderSound, 0); } }, true);   // capture: the volume line below stops the event
    return row;
  });
  // precise list for the channel being worked on
  const f = chans.find((c) => chanKey(c.k) === S.snd.focus);
  const keys = !f ? null : el("div", { class: "snd-keys" },
    el("div", { class: "snd-krow" }, el("b", {}, `Keyframes: ${f.title}`), el("span", { class: "grow" }),
      el("button", { title: "Add a keyframe at the playhead, at the level the line has there", onclick: () => { const t = S.time - f.start; if (t < 0 || t > f.dur) { toast("Move the playhead inside this channel"); return; } sndAddKey(f, t); } }, "＋ Keyframe at playhead"),
      el("button", { onclick: () => sndFade(f, "in", 1) }, "Fade in 1s"), el("button", { onclick: () => sndFade(f, "out", 1) }, "Fade out 1s"),
      f.obj.vol?.length ? el("button", { onclick: () => commit((tl) => { delete volObj(tl, f.k).vol; }) }, "Reset") : null),
    f.obj.vol?.length ? el("div", { class: "snd-ktable" }, el("span", { class: "th" }, "Time (s)"), el("span", { class: "th" }, "Level (dB)"), el("span", {}),
      ...f.obj.vol.flatMap((p, idx) => [
        el("input", { type: "number", class: "nbox", step: "0.05", min: "0", value: p.t, onchange: (e) => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) commit((tl) => { const o = volObj(tl, f.k); o.vol[idx].t = r3(clamp(v, 0, f.dur)); o.vol.sort((a, b) => a.t - b.t); }); } }),
        el("input", { type: "number", class: "nbox", step: "0.5", min: DB_MIN, max: DB_MAX, value: p.db, onchange: (e) => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) commit((tl) => { volObj(tl, f.k).vol[idx].db = clamp(v, DB_MIN, DB_MAX); }); } }),
        el("button", { class: "x", title: "Remove this keyframe", onclick: () => commit((tl) => { const o = volObj(tl, f.k); o.vol.splice(idx, 1); if (!o.vol.length) delete o.vol; }) }, "×")]))
      : el("div", { class: "hint" }, "No keyframes yet. Click on the yellow line above to add one, drag it up or down, double-click to remove. Two points with the second one lower make a smooth fade."));
  const meter = el("div", { class: "meter" }, el("div", { class: "mtitle" }, "Master"),
    el("div", { class: "mscale" }, ...[0, -6, -12, -24, -36, -48, -60].map((d) => el("span", { style: { bottom: ((d + 60) / 60) * 100 + "%" } }, String(d)))),
    el("div", { class: "mbars" }, ...[0, 1].map(() => el("div", { class: "mbar" }, el("i"), el("u")))),
    el("div", { class: "mread" }, "-∞"), el("div", { class: "munit" }, "dB"),
    el("div", { class: "mfade" }, el("input", { type: "range", min: -40, max: 6, step: 0.5, value: S.tl.master_db || 0, title: "Master volume for the whole movie",
      oninput: (e) => { const v = parseFloat(e.target.value); commit((tl) => { if (v) tl.master_db = v; else delete tl.master_db; }, "master"); e.target.nextSibling.textContent = `${v > 0 ? "+" : ""}${v} dB`; } }),
      el("span", {}, `${(S.tl.master_db || 0) > 0 ? "+" : ""}${S.tl.master_db || 0} dB`)));
  const main = el("div", { class: "snd-main" }, closeUp, ...rows, ...(chans.length ? [] : [el("div", { class: "hint" }, "This clip has no sound.")]), ...(keys ? [keys] : []),
    el("div", { class: "hint" }, "0 dB is full volume, -6 dB about half, -40 dB silent. Straight lines between keyframes. The music eases down under a clip that has its own sound: set how far with Volume under clip sound in Settings."));
  box.replaceChildren(head, el("div", { class: "snd-grid" }, main, meter));
  moveSoundHead();
}
function moveSoundHead() {
  const box = $("#sound"); if (!box || box.classList.contains("hidden")) return;
  drawMeter();
  box.querySelectorAll(".snd-ph").forEach((p) => { const a = +p.dataset.a, d = +p.dataset.d, x = (S.time - a) / d; p.style.display = x < 0 || x > 1 ? "none" : "block"; p.style.left = x * 100 + "%"; });
  if (!S.playing && box.dataset.t === String(S.time)) return; box.dataset.t = String(S.time);
  const win = sndWindow(); if (!win) return;
  sndChannels(win).forEach((ch) => { const s = box.querySelector(`.lvl[data-ch="${chanKey(ch.k)}"]`); if (s) s.textContent = chanLevel(ch, S.time); });
}

// Level at the playhead in decibels: the loudness of the file there (peak, 0 dB = loudest possible), then the clip's volume and volume line applied.
function peakDb(src, t) {
  const w = waveFor(src); if (!w) return null;
  const v = w.peaks[Math.floor(Math.max(0, t) * w.per_sec)]; if (v == null) return null;
  return v <= 0 ? -Infinity : 20 * Math.log10(Math.pow(10, (v / 100) * 3.2 - 3.2));
}
function lineDb(pts, t) {
  if (!pts?.length) return 0;
  if (t <= pts[0].t) return pts[0].db;
  for (let i = 1; i < pts.length; i++) if (t <= pts[i].t) { const a = pts[i - 1], b = pts[i]; return b.t === a.t ? b.db : a.db + ((b.db - a.db) * (t - a.t)) / (b.t - a.t); }
  return pts[pts.length - 1].db;
}
function renderDbRead() {
  const box = $("#dbRead"); if (!box || !S.tl) return;
  const it = lay().items.find((x) => !x.isOpener && S.time >= x.start && S.time < x.start + x.duration), parts = [];
  const fmtDb = (d) => (d == null ? "…" : d === -Infinity || d < -60 ? "silent" : `${d.toFixed(1)} dB`);
  if (it && it.clip.kind === "video" && mediaInfo(it.clip.src)?.has_audio !== false) {
    const c = it.clip, off = S.time - it.start, base = peakDb(c.src, (c.in ?? 0) + off * (c.speed || 1));
    const gain = c.volume > 0 ? 20 * Math.log10(c.volume) + lineDb(c.vol, off) : -Infinity;
    parts.push(c.volume > 0 ? `Clip ${fmtDb(base == null ? null : base + gain)}` : `Clip muted (file ${fmtDb(base)})`);
  }
  const L = lay(), m = S.tl.music;
  if (m) {
    const sp = musicSpan(S.tl, 0), t = S.time - L.openerSeconds - sp.start;
    if (t >= 0 && t <= sp.end - sp.start) { const base = peakDb(m.src, (m.offset ?? 0) + t); parts.push(`Music ${fmtDb(base == null ? null : base + 20 * Math.log10(m.volume ?? 0.8) + lineDb(m.vol, t))}`); }
  }
  box.textContent = parts.length ? "🔊 " + parts.join(" · ") : "";
  box.title = "Loudness at the playhead (the loudest moment of that instant). 0 dB is the loudest a file can be.";
}
function jumpClip(dir) {
  const starts = lay().items.map((it) => it.start).sort((a, b) => a - b);
  const t = dir > 0 ? starts.find((s) => s > S.time + 0.05) : [...starts].reverse().find((s) => s < S.time - 0.05);
  if (t != null) seek(t + 0.001);
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------
// Track switches on the left of the timeline (CapCut style): lock, show / hide, sound.
const TK_ICON = {
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  unlock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A9.6 9.6 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.3 4M6.5 6.6A17 17 0 0 0 2 12s4 7 10 7a9.7 9.7 0 0 0 4-.9M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>',
};
// Sound wave under a clip or song, like CapCut. The server measures loudness once per file (20 values a second); we draw the part the clip uses.
S.soundOpen = new Set();                 // clips whose sound is opened below the picture (not saved)
S.wave = new Map();                      // src -> { peaks, per_sec } | "wait" | "none"
function waveFor(src) {
  const w = S.wave.get(src);
  if (w && w !== "wait") return w === "none" ? null : w;
  if (!w) {
    S.wave.set(src, "wait");
    const poll = async (n) => {
      const r = await api(`/waveform?src=${encodeURIComponent(src)}`).catch(() => null);
      if (r?.ready) { S.wave.set(src, r.peaks.length ? r : "none"); if (r.peaks.length) { clearTimeout(waveFor.t); waveFor.t = setTimeout(renderTimeline, 120); } }
      else if (r && n < 120) setTimeout(() => poll(n + 1), 2000);
      else S.wave.set(src, "none");
    };
    poll(0);
  }
  return null;
}
// Level in dB that the wave is drawn on, like the dB lines: the bottom is silence (-40 dB), 0 dB is near the top.
// gainDb(frac) = the clip's volume and volume line (in dB) a fraction `frac` of the way along; -Infinity when muted. Muted = a flat line at the bottom.
const gainOf = (obj, dflt, tAt) => (frac) => { const v = obj.volume ?? dflt; return v > 0 ? 20 * Math.log10(v) + lineDb(obj.vol, tAt(frac)) : -Infinity; };
function waveCanvas(src, from, len, widthPx, dim, H = 28, gainDb = null) {
  const w = waveFor(src), cv = el("canvas", { class: "wave" + (dim ? " dim" : "") });
  if (!w) return cv;
  const W = Math.min(3000, Math.max(8, Math.round(widthPx))), bar = 3, n = Math.max(1, Math.floor(W / bar));
  cv.width = W; cv.height = H;
  const g = cv.getContext("2d"); g.fillStyle = "rgba(200,184,150,.9)";
  for (let b = 0; b < n; b++) {
    const a = Math.floor((from + (b / n) * len) * w.per_sec), z = Math.max(a + 1, Math.ceil((from + ((b + 1) / n) * len) * w.per_sec));
    let m = 0; for (let k = a; k < z && k < w.peaks.length; k++) if (w.peaks[k] > m) m = w.peaks[k];
    const db = 20 * (m / 100 * 3.2 - 3.2) + (gainDb ? gainDb((b + 0.5) / n) : 0);          // file loudness + volume = what you hear
    const h = Math.max(1, ((clamp(db, -40, 6) + 40) / 46) * H);                            // bottom = silent
    g.fillRect(b * bar, H - h, bar - 1, h);
  }
  return cv;
}

// Volume line (decibels over time) drawn on a selected clip or song: click the line to add a point, drag a point, double-click it to remove.
const DB_MAX = 6, DB_MIN = -40;
const dbToY = (db) => (DB_MAX - clamp(db, DB_MIN, DB_MAX)) / (DB_MAX - DB_MIN);
const volObj = (tl, k) => (k.kind === "clip" ? tl.clips.find((c) => c.id === k.id) : k.kind === "layer" ? (tl.layers || []).find((l) => l.id === k.id) : musicAt(tl, k.i));
const dbOfVol = (v) => (v > 0 ? Math.max(DB_MIN, Math.round(20 * Math.log10(v) * 10) / 10) : DB_MIN);
const volOfDb = (db) => (db <= DB_MIN ? 0 : Math.round(Math.pow(10, db / 20) * 1000) / 1000);
function volDragPoint(k, idx, e, box, t0, tLen, dur) {
  const rect = box.getBoundingClientRect(), key = `volline:${k.kind}:${k.id ?? k.i}`;
  const mv = (ev) => {
    const t = r3(clamp(t0 + ((ev.clientX - rect.left) / rect.width) * tLen, 0, dur)), db = Math.round(clamp(DB_MAX - ((ev.clientY - rect.top) / rect.height) * (DB_MAX - DB_MIN), DB_MIN, DB_MAX) * 2) / 2;
    commit((tl) => { const o = volObj(tl, k), p = o.vol[idx]; if (!p) return; p.t = idx === 0 || idx === o.vol.length - 1 ? clamp(t, o.vol[idx - 1]?.t ?? 0, o.vol[idx + 1]?.t ?? dur) : clamp(t, o.vol[idx - 1].t, o.vol[idx + 1].t); p.db = db; }, key);
  };
  const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
  window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
}
// t0 / tLen: which part of the item's time the block's width shows (a clip block hides half of each transition)
function volOverlay(k, obj, dur, t0 = 0, tLen = dur) {
  const pts = obj.vol || [], box = el("div", { class: "volbox", title: "Volume line: click to add a point, drag it up or down, double-click a point to remove it" });
  const X = (t) => clamp((t - t0) / tLen, 0, 1) * 100, Y = (db) => dbToY(db) * 100;
  const line = pts.length ? [pts[0].t > t0 ? [t0, pts[0].db] : null, ...pts.map((p) => [p.t, p.db]), pts[pts.length - 1].t < t0 + tLen ? [t0 + tLen, pts[pts.length - 1].db] : null].filter(Boolean) : [[t0, 0], [t0 + tLen, 0]];
  const svg = el("div", { class: "volsvg" });
  svg.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none"><line x1="0" x2="100" y1="${Y(0)}" y2="${Y(0)}" class="zero"/><polyline points="${line.map(([t, db]) => `${X(t)},${Y(db)}`).join(" ")}" /></svg>`;
  box.append(svg, ...pts.map((p, idx) => el("div", { class: "volpt", style: { left: X(p.t) + "%", top: Y(p.db) + "%" }, title: `${p.db} dB`,
    onpointerdown: (e) => { e.stopPropagation(); e.preventDefault(); volDragPoint(k, idx, e, box, t0, tLen, dur); },
    ondblclick: (e) => { e.stopPropagation(); commit((tl) => { const o = volObj(tl, k); o.vol.splice(idx, 1); if (!o.vol.length) delete o.vol; }); } })));
  box.onpointerdown = (e) => {
    e.stopPropagation(); e.preventDefault();
    const r = box.getBoundingClientRect(), t = r3(clamp(t0 + ((e.clientX - r.left) / r.width) * tLen, 0, dur));
    const db = Math.round(clamp(DB_MAX - ((e.clientY - r.top) / r.height) * (DB_MAX - DB_MIN), DB_MIN, DB_MAX) * 2) / 2;
    let at = 0;
    commit((tl) => { const o = volObj(tl, k); o.vol = o.vol || []; at = o.vol.findIndex((p) => p.t > t); if (at < 0) at = o.vol.length; o.vol.splice(at, 0, { t, db }); });
    volDragPoint(k, at, e, box, t0, tLen, dur);
  };
  return box;
}
// "Level" in decibels for a clip, layer or song: 0 dB = full, -6 dB about half, -40 dB silent.
function dbLevel(obj, dflt, set) {
  return slider2(dbOfVol(obj.volume ?? dflt), DB_MIN, 0, 0.5, (db) => set(volOfDb(db)), { unit: "dB" });
}
function volLineSection(obj, onReset) {
  return el("div", { class: "hint" }, obj.vol?.length ? `Volume line: ${obj.vol.length} point${obj.vol.length > 1 ? "s" : ""}. ` : "Select it on the timeline, then click the line to change the sound over time. ",
    obj.vol?.length ? el("button", { class: "linkish", onclick: onReset }, "Reset volume line") : null);
}

// A video track is silent when it is muted, or when every clip on it has its own sound at 0. The speaker shows that, and one click fixes it either way.
const trackItems = (tl, key) => (key === "v1" ? tl.clips.filter((c) => c.kind === "video") : (tl.layers || []).filter((l) => "v" + l.lane === key && l.kind === "video"));
const trackSilent = (key) => {
  if (S.tl.tracks?.[key]?.mute) return true;
  if (key[0] !== "v") return false;
  const its = trackItems(S.tl, key).filter((x) => mediaInfo(x.src)?.has_audio !== false);
  return its.length > 0 && its.every((x) => !(x.volume > 0));
};
function toggleTrack(key, what) {
  const turnOn = what === "mute" && trackSilent(key);       // silent now: switch the sound on
  commit((tl) => {
    tl.tracks = tl.tracks || {};
    const t = (tl.tracks[key] = { ...(tl.tracks[key] || {}) });
    if (what === "mute") {
      if (turnOn) { delete t.mute; if (key[0] === "v") trackItems(tl, key).forEach((x) => { if (!(x.volume > 0) && mediaInfo(x.src)?.has_audio !== false) x.volume = 1; }); }
      else t.mute = true;
    } else if (t[what]) delete t[what]; else t[what] = true;
    if (!Object.keys(t).length) delete tl.tracks[key];
    if (!Object.keys(tl.tracks).length) delete tl.tracks;
  });
  renderAll(); if (what === "mute") toast(turnOn ? "Sound on" : "Sound off");
}
function renderTrackHeads() {
  const tr = S.tl.tracks || {}, NAMES = { v1: "Video 1", v2: "Video 2", v3: "Video 3", m1: "Music 1", m2: "Music 2", m3: "Music 3" };
  document.querySelectorAll(".tl-labels .lab[data-track]").forEach((lab) => {
    const k = lab.dataset.track, st = tr[k] || {}, isV = k[0] === "v", n = NAMES[k];
    const btn = (what, on, icon, tip) => { const b = el("button", { class: "tk" + (on ? " off" : ""), title: tip, onclick: () => toggleTrack(k, what) }); b.innerHTML = icon; return b; };
    lab.replaceChildren(
      btn("mute", trackSilent(k), trackSilent(k) ? TK_ICON.mute : TK_ICON.sound, trackSilent(k) ? `${n}: no sound. Click to turn it on` : `${n}: mute the sound`),
      ...(isV ? [btn("hide", st.hide, st.hide ? TK_ICON.eyeOff : TK_ICON.eye, st.hide ? `${n}: hidden. Click to show` : `${n}: hide the picture`)] : []),
      btn("lock", st.lock, st.lock ? TK_ICON.lock : TK_ICON.unlock, st.lock ? `${n}: locked. Click to unlock` : `${n}: lock so nothing moves by accident`));
  });
  for (const [id, k] of [["trackV3", "v3"], ["trackV2", "v2"], ["trackVideo", "v1"]]) $("#" + id).classList.toggle("is-hidden", !!tr[k]?.hide);
}

function renderTimeline() {
  const { items, total, openerSeconds } = lay();
  const pps = S.pps;
  const SLACK = 1; // seconds of room after the last clip (just enough to drop a clip at the end)
  const width = Math.max($("#tlScroll").clientWidth, (total + SLACK) * pps);
  $("#tlInner").style.width = width + "px";

  // Ruler, CapCut style: 00:03 labels at a steady spacing, small dots between them
  const NICE = [0.5, 1, 2, 3, 5, 10, 15, 30, 60, 120, 300];
  const major = NICE.find((n) => n * pps >= 80) ?? 600, minors = major === 3 ? 3 : major >= 5 ? 5 : 2;
  const lab = (s) => { const m = Math.floor(s / 60), r = s - m * 60; return `${String(m).padStart(2, "0")}:${(major < 1 ? r.toFixed(1).padStart(4, "0") : String(Math.round(r)).padStart(2, "0"))}`; };
  const ticks = [], sub = major / minors;
  for (let k = 0; k * sub <= total + SLACK + 1e-6; k++) {
    const s = k * sub, isMajor = k % minors === 0;
    ticks.push(el("div", { class: "tick" + (isMajor ? " major" : ""), style: { left: s * pps + "px" } }, isMajor ? el("span", {}, lab(s)) : null));
  }
  $("#ruler").replaceChildren(...ticks);

  // Video track
  const vids = [], anyOpen = S.tl.clips.some((c) => S.soundOpen.has(c.id));
  $("#trackVideo").style.height = anyOpen ? "136px" : ""; document.querySelector(".tl-labels .l-v1").style.height = anyOpen ? "136px" : "";
  items.forEach((it, idx) => {
    const c = it.clip;
    const gr = c.group ? groupOf(c.group) : null;
    if (gr?.collapsed) {                       // a collapsed compound clip is drawn as one block
      const mem = items.filter((x) => x.clip.group === gr.id);
      if (mem[0] !== it) return;
      const first = mem[0], last = mem[mem.length - 1];
      vids.push(el("div", { class: "blk video collapsed" + (S.sel?.t === "group" && S.sel.id === gr.id ? " sel" : ""),
        style: { left: first.start * pps + "px", width: Math.max(8, (last.start + last.duration - first.start) * pps - 2) + "px", zIndex: String(idx + 1) },
        title: "Compound clip - double-click to open", onpointerdown: (e) => groupPointerDown(e, gr.id), ondblclick: () => commit((tl) => { groupOf(gr.id).collapsed = false; }) },
        el("div", { class: "lbl" }, "▣ " + gr.name), el("div", { class: "dur" }, `${tc(last.start + last.duration - first.start)} · ${mem.length} clips`)));
      return;
    }
    const sel = S.sel?.t === "clip" && S.sel.id === c.id;
    const blk = el("div", {
      "data-pick": it.isOpener ? null : "clip:" + c.id,
      class: `blk ${c.kind}${it.isOpener ? " opener" : ""}${sel ? " sel" : ""}${S.multi.includes(c.id) ? " multi" : ""}${S.chat.pending?.ids?.includes(c.id) ? " proposed" : ""}${gr ? " grouped" : ""}${isLocked(c) ? " locked" : ""}${c.kind === "video" && mediaInfo(c.src)?.has_audio !== false ? " hasw" : ""}`,
      // Show the cut in the middle of each transition so blocks don't overlap (like CapCut).
      style: { left: (it.start + it.transIn / 2) * pps + "px", width: Math.max(8, (it.duration - it.transIn / 2 - it.transOut / 2) * pps - 2) + "px", backgroundImage: it.isOpener ? "" : `url("${thumbUrl(c.src)}")`, zIndex: String(idx + 1) },
      "data-id": c.id,
    },
      el("div", { class: "lbl" }, it.isOpener ? "Opener" : (c.text?.value ? "T · " : "") + (c.label || c.src.split("/").pop())),
      el("div", { class: "dur" }, `${tc(it.duration)}${c.speed && c.speed !== 1 ? ` · ${c.speed}x` : ""}`),
      !it.isOpener && c.kind === "video" && mediaInfo(c.src)?.has_audio !== false ? el("div", { class: "badge wvb" + (S.soundOpen.has(c.id) ? " on" : ""), title: S.soundOpen.has(c.id) ? "Close the sound view" : "Open this clip's sound below it: wave, volume line and dB",
        onpointerdown: (e) => { e.stopPropagation(); e.preventDefault(); S.soundOpen.has(c.id) ? S.soundOpen.delete(c.id) : S.soundOpen.add(c.id); renderTimeline(); } }, "∿") : null,
      !it.isOpener && c.kind === "video" ? el("div", { class: "badge spk" + (c.volume > 0 ? " on" : ""), title: c.volume > 0 ? "Clip sound is ON. Click to mute it." : "Clip sound is OFF. Click to hear it.",
        onpointerdown: (e) => { e.stopPropagation(); e.preventDefault(); toggleClipSound(c.id); } }, c.volume > 0 ? "🔊" : "🔇") : null,
      !it.isOpener && c.kind === "video" && mediaInfo(c.src)?.has_audio !== false ? waveCanvas(c.src, c.in ?? 0, ((c.out ?? 0) - (c.in ?? 0)), (it.duration - it.transIn / 2 - it.transOut / 2) * pps, false, 28, gainOf(c, 0, (f) => it.transIn / 2 + f * (it.duration - it.transIn / 2 - it.transOut / 2))) : null,
            !it.isOpener && isLocked(c) ? el("div", { class: "lockic" }, "🔒") : null,
      !it.isOpener && !isLocked(c) ? el("div", { class: "h l", "data-h": "l" }) : null,
      !it.isOpener && !isLocked(c) ? el("div", { class: "h r", "data-h": "r" }) : null,
    );
    if (!it.isOpener) blk.addEventListener("pointerdown", (e) => clipPointerDown(e, c.id));
    if (anyOpen) { blk.style.bottom = "auto"; blk.style.height = "50px"; }
    if (!it.isOpener && S.soundOpen.has(c.id) && c.kind === "video") {
      const wpx = (it.duration - it.transIn / 2 - it.transOut / 2) * pps - 2, panel = el("div", { class: "soundpanel", style: { left: (it.start + it.transIn / 2) * pps + "px", width: Math.max(8, wpx) + "px" } });
      panel.append(waveCanvas(c.src, c.in ?? 0, (c.out ?? 0) - (c.in ?? 0), wpx, false, 64, gainOf(c, 0, (f) => f * it.duration)),
        ...[0, -10, -20, -30].map((db) => el("div", { class: "dbline", style: { top: dbToY(db) * 100 + "%" } }, el("span", {}, db + " dB"))));
      vids.push(panel);
    }
    vids.push(blk);
    // Transition diamond at the cut into this clip
    if (!it.isOpener && (idx > 0)) {
      const tt = it.transIn > 0 ? it.transInType : "cut";
      vids.push(el("div", { class: "trans " + tt, title: `Transition: ${tt} (click to change)`, style: { left: (it.start + it.transIn / 2) * pps - 1 + "px" },
        onpointerdown: (e) => e.stopPropagation(),
        onclick: (e) => { e.stopPropagation(); S.sel = { t: "clip", id: c.id }; renderAll(); $("#insp-trans")?.scrollIntoView({ block: "center" }); } }));
    }
  });
  // Group bands: one purple bar per compound clip above its clips
  const bands = (S.tl.groups || []).map((g) => {
    const mem = items.filter((x) => x.clip.group === g.id); if (!mem.length) return null;
    const first = mem[0], last = mem[mem.length - 1];
    return el("div", { class: "grp" + (S.sel?.t === "group" && S.sel.id === g.id ? " sel" : ""),
      style: { left: first.start * pps + "px", width: Math.max(10, (last.start + last.duration - first.start) * pps - 2) + "px" },
      title: "Compound clip - drag to move it, click to select, double-click to collapse/expand",
      onpointerdown: (e) => groupPointerDown(e, g.id), ondblclick: () => commit((tl) => { const gg = tl.groups.find((x) => x.id === g.id); gg.collapsed = !gg.collapsed; }) },
      (g.collapsed ? "▸ " : "▾ ") + g.name + (g.locked ? " 🔒" : g.seconds ? `  ${g.seconds.toFixed(1)}s` : ""),
      g.seconds && !g.locked ? el("div", { class: "gh", "data-h": "r", title: "Drag to change the group's length" }) : null);
  }).filter(Boolean);
  $("#trackGroup").replaceChildren(...bands);
  const tv = $("#trackVideo"); tv.replaceChildren(...vids);
  tv.ondragover = (e) => { if (e.dataTransfer.types.includes("text/montage-src")) { e.preventDefault(); showDropMark(dropIndexAt(e.clientX)); } };
  tv.ondragleave = () => hideDropMark();
  tv.ondrop = (e) => {
    e.preventDefault(); hideDropMark();
    const m = mediaInfo(e.dataTransfer.getData("text/montage-src")); if (m) addMedia(m, dropIndexAt(e.clientX));
  };

  // Text track
  const texts = (S.tl.texts || []).map((t) => {
    const sel = S.sel?.t === "text" && S.sel.id === t.id;
    const w = window.MontagePlayer.textWindow(t, items, openerSeconds);
    const blk = el("div", { "data-pick": "text:" + t.id, class: "blk text" + (sel ? " sel" : "") + (inX("text", t.id) ? " multi" : "") + (t.locked ? " locked" : ""), style: { left: (openerSeconds + w.start) * pps + "px", width: Math.max(8, (w.end - w.start) * pps) + "px" } },
      el("div", { class: "lbl" }, (t.follow ? "⛓ " : "") + t.value.replace(/\n/g, " · ")), t.locked ? el("div", { class: "lockic" }, "🔒") : null,
      t.locked ? null : el("div", { class: "h l", "data-h": "l" }), t.locked ? null : el("div", { class: "h r", "data-h": "r" }));
    blk.addEventListener("pointerdown", (e) => textPointerDown(e, t.id));
    return blk;
  });
  $("#trackText").replaceChildren(...texts);

  // Music: three channels. Each piece sits on the channel in its `lane` (default 1), so songs can play at the same time.
  const byLane = { 1: [], 2: [], 3: [] }, nm = musicCount(S.tl), songName = (src) => src.split("/").pop().replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
  const hue = (src) => { let h = 0; for (const ch of src) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  for (let i = 0; i < nm; i++) {
    const m = musicAt(S.tl, i), sp = musicSpan(S.tl, i), from = openerSeconds + sp.start, to = openerSeconds + sp.end, ln = laneOf(m);
    const selM = S.sel?.t === "music" && (S.sel.i || 0) === i;
    const bg = `hsl(${hue(m.src)} 38% ${selM ? 36 : 28}%)`;
    byLane[ln].push(el("div", { "data-pick": "music:" + i, class: "blk music" + (selM ? " sel" : "") + (inX("music", i) ? " multi" : "") + (S.tl.music?.locked ? " locked" : ""),
      style: { left: from * pps + "px", width: Math.max(8, (to - from) * pps) + "px", cursor: "grab", background: bg },
      title: `Music ${ln}: ${songName(m.src)}  ${fmt(from)} to ${fmt(to)}. Drag to move it. Select it to replace the song, change its channel or end, or press Split (S) to cut it at the playhead.`,
      onpointerdown: (e) => musicPointerDown(e, i) },
      waveCanvas(m.src, m.offset ?? 0, to - from, (to - from) * pps, false, 28, gainOf(m, 0.8, (f) => f * (to - from))),
      el("div", { class: "lbl" }, `♫ ${songName(m.src)}`, el("span", { class: "tm" }, ` ${fmt(from)} to ${fmt(to)}`)),
      (m.fade_in ?? 0) > 0 && i > 0 ? el("div", { class: "fadein", style: { width: Math.min((to - from) * pps, (m.fade_in ?? 0) * pps) + "px" }, title: "fade in" }) : null,
      (m.fade_out ?? 2) > 0 && m.until != null ? el("div", { class: "fadeout", style: { width: Math.min((to - from) * pps, (m.fade_out ?? 2) * pps) + "px" }, title: "fade out" }) : null,
            !S.tl.music?.locked ? el("div", { class: "h l", "data-h": "l", title: "Drag to trim the start of the song" }) : null,
      !S.tl.music?.locked ? el("div", { class: "h r", "data-h": "r", title: "Drag to trim the end of the song" }) : null));
    if (i > 0) byLane[ln].push(el("div", { class: "songcut", style: { left: from * pps + "px" }, title: `Song ${i + 1} starts here: ${songName(m.src)}` }, el("span", {}, "▶")));
  }
  for (const b of (S.tl.beats || []).filter((b) => openerSeconds + b <= total + SLACK)) byLane[1].push(el("div", { class: "beat", style: { left: (openerSeconds + b) * pps + "px" } }));
  [[1, "#trackMusic"], [2, "#trackMusic2"], [3, "#trackMusic3"]].forEach(([ln, id]) => {
    const tr = $(id); tr.replaceChildren(...byLane[ln]);
    tr.ondragover = (e) => { if (e.dataTransfer.types.includes("text/montage-src")) { e.preventDefault(); tr.classList.add("drop-on"); } };
    tr.ondragleave = () => tr.classList.remove("drop-on");
    tr.ondrop = (e) => { e.preventDefault(); tr.classList.remove("drop-on"); const m = mediaInfo(e.dataTransfer.getData("text/montage-src")); if (!m) return; if (m.kind !== "audio") { toast("Drop a song on a music channel"); return; } addMusicAt(m, ln, timeAt(e.clientX)); };
  });
  // Extra video channels: clips drawn on top of the main video.
  [[3, "#trackV3"], [2, "#trackV2"]].forEach(([ln, id]) => {
    const tr = $(id);
    tr.replaceChildren(...(S.tl.layers || []).filter((l) => l.lane === ln).map((l) => {
      const selL = S.sel?.t === "layer" && S.sel.id === l.id;
      return el("div", { "data-pick": "layer:" + l.id, class: `blk ${l.kind}${selL ? " sel" : ""}${inX("layer", l.id) ? " multi" : ""}`, title: `Video ${ln}: ${l.label || l.src.split("/").pop()}  ${fmt(l.start)} to ${fmt(l.end)}. Drag to move, drag the edges to trim.`,
        style: { left: (openerSeconds + l.start) * pps + "px", width: Math.max(8, (l.end - l.start) * pps - 2) + "px", backgroundImage: `url("${thumbUrl(l.src)}")` },
        onpointerdown: (e) => layerPointerDown(e, l.id) },
        el("div", { class: "lbl" }, l.label || l.src.split("/").pop()),
        l.kind === "video" ? el("div", { class: "badge spk" + (l.volume > 0 ? " on" : ""), title: l.volume > 0 ? "Sound is ON. Click to mute it." : "Sound is OFF. Click to hear it.",
          onpointerdown: (e) => { e.stopPropagation(); e.preventDefault(); commit((tl) => { const x = tl.layers.find((q) => q.id === l.id); x.volume = x.volume > 0 ? 0 : 1; }); } }, l.volume > 0 ? "🔊" : "🔇") : null,
                el("div", { class: "h l", "data-h": "l" }), el("div", { class: "h r", "data-h": "r" }));
    }));
    tr.ondragover = (e) => { if (e.dataTransfer.types.includes("text/montage-src")) { e.preventDefault(); tr.classList.add("drop-on"); } };
    tr.ondragleave = () => tr.classList.remove("drop-on");
    tr.ondrop = (e) => { e.preventDefault(); tr.classList.remove("drop-on"); const m = mediaInfo(e.dataTransfer.getData("text/montage-src")); if (!m) return; if (m.kind === "audio") { toast("Drop a photo or a video on a video channel"); return; } addLayer(m, ln, timeAt(e.clientX)); };
  });
  $("#trackNotes").replaceChildren(...cmFlags());
  renderPlayhead();
}

let dropMark = null;
function dropIndexAt(clientX) {
  const rect = $("#tlInner").getBoundingClientRect();
  const t = (clientX - rect.left) / S.pps;
  const items = lay().items.filter((it) => !it.isOpener);
  let i = 0;
  for (const it of items) { if (t > it.start + it.duration / 2) i++; }
  return i;
}
function showDropMark(i) {
  const items = lay().items.filter((it) => !it.isOpener);
  const x = i < items.length ? items[i].start : (items.length ? items[items.length - 1].start + items[items.length - 1].duration : lay().openerSeconds);
  if (!dropMark) { dropMark = el("div", { class: "drop-mark" }); $("#trackVideo").append(dropMark); }
  dropMark.style.left = x * S.pps - 1 + "px";
}
function hideDropMark() { dropMark?.remove(); dropMark = null; }

// Clip pointer: click = select, drag body = reorder, drag handle = trim.
const laneOf = (m) => m.lane || 1;
const timeAt = (clientX) => Math.max(0, (clientX - $("#tlInner").getBoundingClientRect().left) / S.pps - lay().openerSeconds);
const setAdjust = (x, k, v) => { x.adjust = { ...(x.adjust || {}), [k]: r3(v) }; if (x.adjust[k] === 1) delete x.adjust[k]; if (!Object.keys(x.adjust).length) delete x.adjust; };
function adjustSection(adj, set, reset) {
  return el("div", { class: "sec" }, el("div", { class: "sec-t" }, "Picture"),
    field("Contrast", range(adj.contrast ?? 1, 0.5, 2, 0.05, (v) => set("contrast", v)), (adj.contrast ?? 1).toFixed(2)),
    field("Brightness", range(adj.brightness ?? 1, 0.5, 1.8, 0.05, (v) => set("brightness", v)), (adj.brightness ?? 1).toFixed(2)),
    field("Colour", range(adj.saturation ?? 1, 0, 2, 0.05, (v) => set("saturation", v)), (adj.saturation ?? 1).toFixed(2)),
    Object.keys(adj).length ? el("div", { class: "btns" }, el("button", { onclick: reset }, "Reset picture")) : null);
}

// Extra video channels (tl.layers): clips drawn over the main video on Video 2 / Video 3.
function addLayer(m, lane, t) {
  const len = m.kind === "image" ? 3 : m._cut ? m._cut.out - m._cut.in : Math.min(m.duration || 4, 5), start = r3(Math.max(0, t));
  const l = { id: newId("l"), lane, src: m.src, kind: m.kind, label: m.name.replace(/\.[^.]+$/, ""), start, end: r3(start + len), fit: "cover" };
  if (m.kind === "video") { l.in = m._cut ? r3(m._cut.in) : 0; l.volume = 0; }
  if (m.width && m.height) l.dim = [m.width, m.height];
  commit((tl) => { tl.layers = [...(tl.layers || []), l]; });
  S.sel = { t: "layer", id: l.id }; renderAll(); toast(`Added on Video ${lane}`);
}
function layerPointerDown(e, id) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  if (!e.target.dataset?.h && inX("layer", id) && pickedCount() > 1) return groupDrag(e);
  S.multi = [], S.multiX = []; S.sel = { t: "layer", id };
  if (S.tl.tracks?.["v" + (S.tl.layers || []).find((l) => l.id === id)?.lane]?.lock) { renderAll(); toast("This track is locked"); return; }
  const handle = e.target.dataset?.h, startX = e.clientX, startY = e.clientY, orig = clone((S.tl.layers || []).find((l) => l.id === id));
  const sp = orig.speed || 1, srcDur = mediaInfo(orig.src)?.duration;
  let moved = false;
  const onMove = (ev) => {
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
    moved = true;
    const ds = Math.round(((ev.clientX - startX) / S.pps) * 20) / 20;   // 0.05 s steps
    if (!handle) { const ln = laneAtY(ev.clientY); markLane(ln !== orig.lane ? ln : 0); }   // drag up or down to another video row
    commit((tl) => {
      const l = tl.layers.find((x) => x.id === id);
      if (handle === "r") {
        const maxEnd = orig.kind === "video" && srcDur ? orig.start + (srcDur - (orig.in || 0)) / sp : Infinity;
        l.end = r3(clamp(orig.end + ds, orig.start + 0.2, maxEnd));
      } else if (handle === "l") {
        const minStart = orig.kind === "video" ? Math.max(0, orig.start - (orig.in || 0) / sp) : 0;
        const ns = r3(clamp(orig.start + ds, minStart, orig.end - 0.2));
        if (orig.kind === "video") l.in = r3(Math.max(0, (orig.in || 0) + (ns - orig.start) * sp));
        l.start = ns;
      } else {
        const ns = r3(Math.max(0, orig.start + ds));
        l.start = ns; l.end = r3(ns + (orig.end - orig.start));
      }
    }, `layer:${id}:${handle || "mv"}`);
  };
  const onUp = (ev) => {
    window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); S.lastKey = null; markLane(0);
    if (moved && !handle) {
      const ln = laneAtY(ev.clientY);
      if (ln === 1) { layerToClip(id, dropIndexAt(ev.clientX)); return; }
      if (ln !== orig.lane) { layerToLane(id, ln); return; }
    }
    if (!moved) seek(lay().openerSeconds + orig.start + 0.01);
    renderAll();
  };
  window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
  renderAll();
}
function layerInspector(l) {
  const upd = (key) => (fn) => commit((tl) => fn(tl.layers.find((x) => x.id === l.id)), key ? `layer:${l.id}:${key}` : null);
  const isVid = l.kind === "video";
  return el("div", { class: "insp" },
    el("img", { class: "thumb", src: thumbUrl(l.src, 640) }),
    el("h3", {}, `Video ${l.lane}: ${l.label || l.src.split("/").pop()}`),
    el("div", { class: "sub" }, `${l.src} · ${fmt(l.start)} to ${fmt(l.end)}`),
    field("Track", chips(["1", "2", "3"], String(l.lane), (v) => { if (v === "1") layerToClip(l.id, indexAtMontageTime(lay().openerSeconds + l.start)); else if (parseInt(v) !== l.lane) layerToLane(l.id, parseInt(v)); })),
    el("div", { class: "row" },
      field("Starts (s)", num(l.start, (v) => upd("s")((x) => { const d = x.end - x.start; x.start = r3(Math.max(0, v || 0)); x.end = r3(x.start + d); }))),
      field("Ends (s)", num(l.end, (v) => upd("e")((x) => { x.end = r3(Math.max(x.start + 0.2, v || 0)); })))),
    isVid ? field("Start the clip at (s)", num(l.in ?? 0, (v) => upd("in")((x) => { x.in = r3(Math.max(0, v || 0)); }))) : null,
    isVid ? field("Speed", chips(SPEEDS.map(String), String(l.speed || 1), (v) => upd()((x) => { x.speed = parseFloat(v); }))) : null,
    isVid ? field("Sound", range(l.volume ?? 0, 0, 1, 0.05, (v) => upd("vol")((x) => { x.volume = v; })), `${Math.round((l.volume ?? 0) * 100)}%`) : null,
    frameSection(l, { tf: (k, v) => upd("tf" + k)((x) => { setTf(x, k, v); if (k === null) { if (v) { x.rounded = true; x.fit = "contain"; } else delete x.rounded; } }), crop: (k, v) => upd("cr" + k)((x) => setCrop(x, k === null ? { l: 0, t: 0, r: 0, b: 0 } : { [k]: v })) }, TF_PRESETS_LAYER,
      field("Rounded corners and shadow", el("input", { type: "checkbox", checked: !!l.rounded, onchange: (e) => upd()((x) => { if (e.target.checked) x.rounded = true; else delete x.rounded; }) }))),
    field("Fit", chips(["cover", "contain"], l.fit || "cover", (v) => upd()((x) => { x.fit = v; }))),
    field("Opacity", range(l.opacity ?? 1, 0.1, 1, 0.05, (v) => upd("op")((x) => { if (v >= 1) delete x.opacity; else x.opacity = v; })), `${Math.round((l.opacity ?? 1) * 100)}%`),
    adjustSection(l.adjust || {}, (k, v) => upd("adj" + k)((x) => setAdjust(x, k, v)), () => upd()((x) => { delete x.adjust; })),
    el("div", { class: "btns" }, el("button", { class: "danger", onclick: deleteSelection }, "🗑 Delete")),
    el("div", { class: "hint" }, "This clip plays on top of the main video. Video 3 is above Video 2. Drag it on the timeline to move it, drag its edges to trim. Drop a photo or video from the bin onto a video channel to add one."));
}
function addMusicAt(m, lane, t) {
  const at = r3(Math.max(0, t));
  commit((tl) => {
    if (!tl.music) {            // the first song is always the main track (music_more only holds extra pieces)
      tl.music = { src: m.src, offset: 0, volume: 1, duck_volume: 0.25, fade_in: 0.5, fade_out: 2, start_at: "clips" };
      if (at > 0.05) tl.music.shift = at;
      if (lane > 1) tl.music.lane = lane;
    } else {
      const piece = { src: m.src, offset: 0, volume: 1, duck_volume: 0.25, fade_in: 0.5, fade_out: 1.5, at };
      if (lane > 1) piece.lane = lane;
      tl.music_more = [...(tl.music_more || []), piece];
    }
  });
  S.sel = { t: "music", i: musicCount(S.tl) - 1 }; renderAll(); toast(`Song added on Music ${lane}`);
}
function addMediaTo(m, where) {          // where: "v1" | "v2" | "v3" | "m1" | "m2" | "m3"
  const n = parseInt(where.slice(1)), t = Math.max(0, S.time - lay().openerSeconds);
  if (where === "v1") return addMedia(m);
  if (where[0] === "v") return addLayer(m, n, t);
  if (n === 1 && !S.tl.music) return addMedia(m);
  addMusicAt(m, n, t);
}

// ---------------------------------------------------------------------------
// Position & size of the picture inside the frame (CapCut style): the video is not tied to its frame.
// transform = { x, y (fraction of the frame, 0 = centred), scale (1 = fills the frame), rotate (degrees) }
// ---------------------------------------------------------------------------
const TF_DEFAULT = { x: 0, y: 0, scale: 1, rotate: 0 };
const TF_PRESETS_CLIP = [["Full", null], ["Half, top", { y: -0.25, scale: 0.5 }], ["Half, bottom", { y: 0.25, scale: 0.5 }], ["Small, centre", { scale: 0.5 }]];
const TF_PRESETS_LAYER = [["Full", null], ["Corner ↘", { x: 0.28, y: 0.28, scale: 0.38 }], ["Corner ↖", { x: -0.28, y: -0.28, scale: 0.38 }],
  ["Corner ↗", { x: 0.28, y: -0.28, scale: 0.38 }], ["Corner ↙", { x: -0.28, y: 0.28, scale: 0.38 }], ["Centre", { scale: 0.55 }]];
function ensureDim(x) {                          // remember the picture's true size so the whole picture (not just the part in the frame) moves
  if (!x.dim) { const m = mediaInfo(x.src); if (m?.width && m?.height) x.dim = [m.width, m.height]; }
}
function setTf(x, key, v) {
  ensureDim(x);
  if (key === null) { if (v) x.transform = { ...v }; else delete x.transform; return; }
  const t = { ...(x.transform || {}), [key]: r3(v) };
  if (Math.abs(t[key] - TF_DEFAULT[key]) < 1e-9) delete t[key];
  if (Object.keys(t).length) x.transform = t; else delete x.transform;
}
function setCrop(x, vals) {
  ensureDim(x);
  const c = { ...(x.crop || {}), ...vals };
  for (const k of ["l", "t", "r", "b"]) { c[k] = r3(c[k] || 0); if (!c[k]) delete c[k]; }
  if (Object.keys(c).length) x.crop = c; else delete x.crop;
}
// Clip shape: pick where this clip is going (Reels, Feed...) and its picture is cropped to that shape, centred in the video frame.
// "Whole video" shows the full picture uncropped. The video's own format (Video settings) is the frame; this is the window inside it.
const CLIP_SHAPES = ["Whole video", ...PLATFORMS.map((p) => p.name)];
function applyClipShape(x, name) {
  ensureDim(x);
  delete x.crop; delete x.transform; delete x.focus;
  const p = PLATFORMS.find((q) => q.name === name);
  if (!p) { x.fit = "contain"; return; }
  x.fit = "cover";
  if (!x.dim || x.rotate % 360) return;
  const W = S.tl.format?.width ?? 1080, H = S.tl.format?.height ?? 1920, a = p.size[0] / p.size[1];
  const wh = Math.min(H, W / a), ww = wh * a;                          // largest window of this shape that fits the frame
  const k = Math.max(W / x.dim[0], H / x.dim[1]), pw = x.dim[0] * k, ph = x.dim[1] * k;   // the picture, as it fills the frame
  const cl = Math.max(0, (pw - ww) / 2 / pw), ct = Math.max(0, (ph - wh) / 2 / ph);
  setCrop(x, { l: cl, r: cl, t: ct, b: ct });
}
// A slider with a number box beside it. The box shows the value in the unit you read it in (percent, degrees) and can be typed into.
function slider2(value, min, max, step, onChange, { scale = 1, unit = "" } = {}) {
  const shown = (v) => String(Math.round(v * scale * 10) / 10);
  const box = el("input", { type: "number", class: "nbox", step: String(step * scale), value: shown(value),
    onchange: (e) => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) onChange(clamp(v / scale, min, max)); } });
  const rng = el("input", { type: "range", min, max, step, value, oninput: (e) => { const v = parseFloat(e.target.value); box.value = shown(v); onChange(v); } });
  return el("div", { class: "s2" }, rng, box, el("span", { class: "u" }, unit));
}
const sgn = (v, unit = "%") => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v * 100))}${unit}`;
// A small map of the frame: where the picture sits and what is cropped, plus the same facts in words.
function frameMap(o) {
  const W = S.tl.format?.width ?? 1080, H = S.tl.format?.height ?? 1920, t = o.transform || {}, c = o.crop || {}, h = 116, w = Math.round((h * W) / H);
  const geom = pictureGeom({ tf: t, dim: o.rotate % 360 ? null : dimOf(o), fit: o.fit === "contain" ? "contain" : "cover", focus: o.focus }, W, H);
  const sc = t.scale ?? 1;
  const parts = [`Size ${Math.round(sc * 100)}%`];
  if (t.x) parts.push(`${sgn(t.x)} across`);
  if (t.y) parts.push(`${sgn(-t.y)} up`);
  if (t.rotate) parts.push(`tilt ${Math.round(t.rotate)}°`);
  const cuts = [["l", "left"], ["t", "top"], ["r", "right"], ["b", "bottom"]].filter(([k]) => c[k]).map(([k, n]) => `${n} ${Math.round(c[k] * 100)}%`);
  return el("div", { class: "fm-wrap" },
    el("div", { class: "fm", style: { width: w + "px", height: h + "px" }, title: "The frame, with the whole picture placed in it. Anything outside the frame is cut off." },
      el("div", { class: "fm-box", style: { left: ((geom.cx - geom.bw / 2) / W) * 100 + "%", top: ((geom.cy - geom.bh / 2) / H) * 100 + "%", width: (geom.bw / W) * 100 + "%", height: (geom.bh / H) * 100 + "%", transform: `rotate(${t.rotate ?? 0}deg)` } },
        el("div", { class: "fm-crop", style: { left: (c.l ?? 0) * 100 + "%", top: (c.t ?? 0) * 100 + "%", right: (c.r ?? 0) * 100 + "%", bottom: (c.b ?? 0) * 100 + "%" } }))),
    el("div", { class: "fm-txt" }, el("div", {}, parts.join(" · ")), el("div", {}, cuts.length ? "Cropped: " + cuts.join(", ") : "Not cropped")));
}
// Everything about how the picture sits in its frame. ops.tf(key, value) / ops.crop(key, value); key null = reset or preset.
function frameSection(obj, ops, presets, extra) {
  const t = obj.transform || {}, c = obj.crop || {};
  return el("div", { class: "sec" }, el("div", { class: "sec-t" }, "Position, size & crop"),
    frameMap(obj),
    pixelRow(obj, ops),
    el("div", { class: "hint" }, "Drag the picture on the preview to move it, a corner to resize it. Press Crop under the preview to cut its edges with the mouse. The frame stays where it is."),
    el("div", { class: "chip-row" }, ...presets.map(([n, v]) => el("button", { class: "pre", onclick: () => ops.tf(null, v) }, n))),
    field("Size", slider2(t.scale ?? 1, 0.1, 3, 0.01, (v) => ops.tf("scale", v), { scale: 100, unit: "%" })),
    field("Across (right is +)", slider2(t.x ?? 0, -1, 1, 0.01, (v) => ops.tf("x", v), { scale: 100, unit: "%" })),
    field("Up/down (down is +)", slider2(t.y ?? 0, -1, 1, 0.01, (v) => ops.tf("y", v), { scale: 100, unit: "%" })),
    field("Tilt", slider2(t.rotate ?? 0, -180, 180, 1, (v) => ops.tf("rotate", v), { unit: "°" })),
    el("div", { class: "sec-t", style: { marginTop: "12px" } }, "Crop (cut the edges)"),
    field("Left", slider2(c.l ?? 0, 0, 0.9, 0.01, (v) => ops.crop("l", v), { scale: 100, unit: "%" })),
    field("Top", slider2(c.t ?? 0, 0, 0.9, 0.01, (v) => ops.crop("t", v), { scale: 100, unit: "%" })),
    field("Right", slider2(c.r ?? 0, 0, 0.9, 0.01, (v) => ops.crop("r", v), { scale: 100, unit: "%" })),
    field("Bottom", slider2(c.b ?? 0, 0, 0.9, 0.01, (v) => ops.crop("b", v), { scale: 100, unit: "%" })),
    extra || null,
    el("div", { class: "btns" },
      Object.keys(c).length ? el("button", { onclick: () => ops.crop(null, null) }, "Reset crop") : null,
      Object.keys(t).length ? el("button", { onclick: () => ops.tf(null, null) }, "Reset position") : null));
}
// Where the picture is inside the preview (player pixels): its own proportions, fit, focus, then the transform. Frame-sized when its size is unknown.
function pictureGeom(tg, W, H) {
  const sc = tg.tf.scale ?? 1;
  let pw = W, ph = H, ox = 0, oy = 0;
  if (tg.dim) {
    const k = tg.fit === "contain" ? Math.min(W / tg.dim[0], H / tg.dim[1]) : Math.max(W / tg.dim[0], H / tg.dim[1]);
    pw = tg.dim[0] * k; ph = tg.dim[1] * k;
    ox = (W - pw) * ((tg.focus?.x ?? 0.5) - 0.5); oy = (H - ph) * ((tg.focus?.y ?? 0.5) - 0.5);
  }
  return { bw: pw * sc, bh: ph * sc, cx: W / 2 + (tg.tf.x ?? 0) * W + ox * sc, cy: H / 2 + (tg.tf.y ?? 0) * H + oy * sc };
}
const dimOf = (o) => (o.dim || (() => { const m = mediaInfo(o.src); return m?.width && m?.height ? [m.width, m.height] : null; })());
// The box on the preview for the selected clip or Video 2/3 clip, visible while the playhead is inside it.
function xformTarget() {
  if (!S.tl) return null;
  if (S.sel?.t === "clip") {
    const it = lay().items.find((x) => x.clip.id === S.sel.id);
    if (!it || it.isOpener || S.time < it.start - 1e-6 || S.time > it.start + it.duration) return null;
    return { kind: "clip", id: it.clip.id, tf: it.clip.transform || {}, crop: it.clip.crop || {}, dim: it.clip.rotate % 360 ? null : dimOf(it.clip), fit: it.clip.fit === "cover" || !it.clip.fit ? "cover" : "contain", focus: it.clip.focus };
  }
  if (S.sel?.t === "layer") {
    const l = (S.tl.layers || []).find((x) => x.id === S.sel.id), o = lay().openerSeconds;
    if (!l || S.time < o + l.start || S.time > o + l.end) return null;
    return { kind: "layer", id: l.id, tf: l.transform || {}, crop: l.crop || {}, dim: dimOf(l), fit: l.fit === "contain" ? "contain" : "cover", focus: null };
  }
  return null;
}
S.xfMode = "move";
const xformKey = () => { const t = xformTarget(); return t && !S.chat.showBefore ? t.kind + ":" + t.id : ""; };
function renderXform() {
  const box = $("#xform"), pl = $("#player"), tg = xformTarget();
  S.xfKey = xformKey();
  if (S.chat.showBefore) { box.classList.add("hidden"); box.replaceChildren(); return; }
  const pr = pl.getBoundingClientRect(), br = $("#playerBox").getBoundingClientRect(), W = pr.width, H = pr.height;
  Object.assign(box.style, { left: pr.left - br.left + "px", top: pr.top - br.top + "px", width: W + "px", height: H + "px" });
  // The whole preview is grabbable, like CapCut: press on the video and it is selected and starts moving.
  const hit = el("div", { class: "xf-hit", onpointerdown: hitDown });
  if (!tg) { box.replaceChildren(hit); box.classList.remove("hidden"); return; }
  const g = pictureGeom(tg, W, H);
  const cropping = S.xfMode === "crop", c = tg.crop || {};
  const bar = el("div", { class: "xf-bar" },
    el("button", { class: cropping ? "" : "on", title: "Move and resize the picture", onclick: () => { S.xfMode = "move"; renderXform(); } }, "✥ Move"),
    el("button", { class: cropping ? "on" : "", title: "Cut the edges of the picture", onclick: () => { S.xfMode = "crop"; renderXform(); } }, "⛶ Crop"));
  const cropEl = !cropping ? null : el("div", { class: "xf-crop", style: { left: (c.l ?? 0) * 100 + "%", top: (c.t ?? 0) * 100 + "%", right: (c.r ?? 0) * 100 + "%", bottom: (c.b ?? 0) * 100 + "%" } },
    ...["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((d) => el("div", { class: "xf-ch " + d, onpointerdown: (e) => cropDown(e, tg, d) })));
  const shade = !cropping ? null : el("div", { class: "xf-shade", style: { clipPath: `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${(c.l ?? 0) * 100}% ${(c.t ?? 0) * 100}%, ${(c.l ?? 0) * 100}% ${(1 - (c.b ?? 0)) * 100}%, ${(1 - (c.r ?? 0)) * 100}% ${(1 - (c.b ?? 0)) * 100}%, ${(1 - (c.r ?? 0)) * 100}% ${(c.t ?? 0) * 100}%, ${(c.l ?? 0) * 100}% ${(c.t ?? 0) * 100}%)` } });
  box.replaceChildren(el("div", { class: "xf-box" + (cropping ? " cropping" : ""), title: cropping ? "Drag inside to move the picture. Drag the white squares to crop." : "Drag to move. Drag a corner to resize.",
    style: { left: g.cx - g.bw / 2 + "px", top: g.cy - g.bh / 2 + "px", width: g.bw + "px", height: g.bh + "px", transform: `rotate(${tg.tf.rotate ?? 0}deg)` },
    onpointerdown: (e) => xformDown(e, tg, e.target.classList.contains("xf-h") ? "scale" : "move") },
    shade, cropEl, ...(cropping ? [] : ["nw", "ne", "sw", "se"].map((d) => el("div", { class: "xf-h " + d }))),
    (() => { const q = pxGeom(tg); return el("div", { class: "xf-lab" }, `x ${Math.round(q.left)}, y ${Math.round(q.bottom)}  ·  ${Math.round(q.w)}×${Math.round(q.h)} px`); })()), bar);
  box.replaceChildren(hit, ...box.childNodes);
  box.classList.remove("hidden");
}
// What is under the mouse on the preview: Video 3, then Video 2 (where their picture is), otherwise the main clip at the playhead.
function pickAt(px, py, W, H) {
  const o = lay().openerSeconds;
  for (const lane of [3, 2]) {
    for (const l of (S.tl.layers || []).filter((x) => x.lane === lane && S.time >= o + x.start && S.time <= o + x.end).reverse()) {
      const g = pictureGeom({ tf: l.transform || {}, dim: dimOf(l), fit: l.fit === "contain" ? "contain" : "cover", focus: null }, W, H);
      if (Math.abs(px - g.cx) <= g.bw / 2 && Math.abs(py - g.cy) <= g.bh / 2) return { t: "layer", id: l.id };
    }
  }
  const it = [...lay().items].reverse().find((x) => !x.isOpener && S.time >= x.start - 1e-6 && S.time < x.start + x.duration);
  return it ? { t: "clip", id: it.clip.id } : null;
}
function hitDown(e) {
  if (e.button !== 0) return;
  const pr = $("#player").getBoundingClientRect(), pick = pickAt(e.clientX - pr.left, e.clientY - pr.top, pr.width, pr.height);
  e.preventDefault();
  if (!pick) { S.sel = null; S.multi = [], S.multiX = []; renderAll(); return; }
  S.multi = [], S.multiX = []; S.sel = pick; renderAll();
  const tg = xformTarget(); if (tg) xformDown(e, tg, "move");
}
function xformDown(e, tg, mode) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const pr = $("#player").getBoundingClientRect(), W = pr.width, H = pr.height, tf0 = { ...tg.tf };
  const g0 = pictureGeom(tg, W, H), sx = e.clientX, sy = e.clientY, ccx = pr.left + g0.cx, ccy = pr.top + g0.cy, d0 = Math.hypot(sx - ccx, sy - ccy) || 1;
  const apply = (fn) => commit((tl) => fn(tg.kind === "clip" ? tl.clips.find((c) => c.id === tg.id) : tl.layers.find((l) => l.id === tg.id)), `xf:${tg.id}:${mode}`);
  let moved = false;
  const onMove = (ev) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
    moved = true;
    if (mode === "move") {
      let nx = (tf0.x ?? 0) + (ev.clientX - sx) / W, ny = (tf0.y ?? 0) + (ev.clientY - sy) / H;
      if (Math.abs(nx) < 0.012) nx = 0;                        // snap to the centre lines
      if (Math.abs(ny) < 0.012) ny = 0;
      apply((t) => { setTf(t, "x", nx); setTf(t, "y", ny); });
    } else {
      const ns = clamp((tf0.scale ?? 1) * Math.hypot(ev.clientX - ccx, ev.clientY - ccy) / d0, 0.1, 4);
      apply((t) => setTf(t, "scale", Math.abs(ns - 1) < 0.02 ? 1 : ns));
    }
  };
  const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); S.lastKey = null; renderAll(); };
  window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
}

function cropDown(e, tg, edge) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const pr = $("#player").getBoundingClientRect(), g0 = pictureGeom(tg, pr.width, pr.height), bw = g0.bw, bh = g0.bh, th = ((tg.tf.rotate ?? 0) * Math.PI) / 180;
  const c0 = { l: 0, t: 0, r: 0, b: 0, ...tg.crop }, sx = e.clientX, sy = e.clientY, MAXC = 0.95, MIN = 0.05;
  const onMove = (ev) => {
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    const lx = dx * Math.cos(th) + dy * Math.sin(th), ly = -dx * Math.sin(th) + dy * Math.cos(th);   // mouse movement in the picture's own (tilted) axes
    const n = { ...c0 };
    if (edge.includes("w")) n.l = clamp(c0.l + lx / bw, 0, MAXC - MIN - c0.r);
    if (edge.includes("e")) n.r = clamp(c0.r - lx / bw, 0, MAXC - MIN - n.l);
    if (edge.includes("n")) n.t = clamp(c0.t + ly / bh, 0, MAXC - MIN - c0.b);
    if (edge.includes("s")) n.b = clamp(c0.b - ly / bh, 0, MAXC - MIN - n.t);
    commit((tl) => setCrop(tg.kind === "clip" ? tl.clips.find((c) => c.id === tg.id) : tl.layers.find((l) => l.id === tg.id), n), `crop:${tg.id}`);
  };
  const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); S.lastKey = null; renderAll(); };
  window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
}

// ---------------------------------------------------------------------------
// Pixel rulers: the preview is drawn small, the video is not. Rulers show the REAL pixels of the frame (for example 1080 x 1920),
// so a placement from your inspiration can be checked against true pixel positions.
// ---------------------------------------------------------------------------
const frameSize = () => [S.tl?.format?.width ?? 1080, S.tl?.format?.height ?? 1920];
function pxGeom(tg) {                                   // the picture's box in real frame pixels: {left, top, w, h}
  const [FW, FH] = frameSize(), g = pictureGeom(tg, FW, FH);
  const top = g.cy - g.bh / 2;
  return { left: g.cx - g.bw / 2, top, bottom: FH - (top + g.bh), w: g.bw, h: g.bh, g };   // bottom = distance up from the bottom edge (ruler origin is bottom left)
}
function rulerTicks(len, scale, vertical) {             // len in frame px, scale = screen px per frame px. 0 is bottom left: the vertical ruler counts UP.
  const steps = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
  const major = steps.find((v) => v * scale >= 48) || 2000;
  const minor = [major / 5, major / 2].find((v) => v * scale >= 7 && Number.isInteger(v)) || major;
  const out = [];
  for (let v = 0; v <= len + 0.5; v += minor) {
    const isMaj = Math.abs(v / major - Math.round(v / major)) < 1e-9, pos = (vertical ? len - v : v) * scale;
    const st = vertical ? { top: pos + "px" } : { left: pos + "px" };
    out.push(el("i", { class: isMaj ? "maj" : "min", style: st }));
    if (isMaj) out.push(el("span", { style: st }, String(Math.round(v))));
  }
  return out;
}
function renderRulers() {
  const box = $("#rulers"), btn = $("#rulerBtn");
  document.body.classList.toggle("rulers-on", S.rulers);
  btn.classList.toggle("on", S.rulers);
  box.classList.toggle("hidden", !S.rulers);
  if (!S.rulers || !S.tl) { box.replaceChildren(); return; }
  const pr = $("#player").getBoundingClientRect(), br = $("#playerBox").getBoundingClientRect(), [FW, FH] = frameSize();
  if (!pr.width) return;
  const kx = pr.width / FW, ky = pr.height / FH, l = pr.left - br.left, t = pr.top - br.top;
  const tg = xformTarget(), pg = tg && !S.chat.showBefore ? pxGeom(tg) : null;
  const band = (a, len, k, vertical) => el("div", { class: "band", title: `${Math.round(a)} to ${Math.round(a + len)} px`, style: vertical ? { top: a * k + "px", height: len * k + "px" } : { left: a * k + "px", width: len * k + "px" } });
  box.replaceChildren(
    el("div", { class: "rl-corner", style: { left: l - 40 + "px", top: t - 22 + "px" }, title: "Frame size in pixels" }, `${FW}×${FH}`),
    el("div", { class: "rl rl-top", id: "rlTop", style: { left: l + "px", top: t - 22 + "px", width: pr.width + "px" } }, ...rulerTicks(FW, kx, false), pg ? band(pg.left, pg.w, kx, false) : null, el("div", { class: "mark", id: "rlMarkX", style: { display: "none" } })),
    el("div", { class: "rl rl-left", id: "rlLeft", style: { left: l - 40 + "px", top: t + "px", height: pr.height + "px" } }, ...rulerTicks(FH, ky, true), pg ? band(pg.top, pg.h, ky, true) : null, el("div", { class: "mark", id: "rlMarkY", style: { display: "none" } })));
}
function pxTrack(e) {                                   // the pixel under the mouse, shown on both rulers and in the transport bar
  const read = $("#pxRead"), pr = $("#player").getBoundingClientRect(), [FW, FH] = frameSize();
  const x = ((e.clientX - pr.left) / pr.width) * FW, y = ((e.clientY - pr.top) / pr.height) * FH;
  const inside = x >= 0 && y >= 0 && x <= FW && y <= FH;
  read.textContent = inside ? `x ${Math.round(x)}  y ${Math.round(FH - y)} px` : "";
  const mx = $("#rlMarkX"), my = $("#rlMarkY");
  if (mx && my) { mx.style.display = my.style.display = inside ? "" : "none"; if (inside) { mx.style.left = (x / FW) * pr.width + "px"; my.style.top = (y / FH) * pr.height + "px"; } }
}

// Position and size of the selected picture in real pixels, editable.
function pixelRow(obj, ops) {
  const [FW, FH] = frameSize();
  const tg = { tf: obj.transform || {}, dim: obj.rotate % 360 ? null : dimOf(obj), fit: obj.fit === "contain" ? "contain" : "cover", focus: obj.focus };
  const b = pxGeom(tg), base = pictureGeom({ ...tg, tf: { ...tg.tf, x: 0, y: 0 } }, FW, FH), sc = tg.tf.scale ?? 1;
  const box = (label, val, apply) => el("label", {}, label, el("input", { type: "number", step: "1", value: String(Math.round(val)), onchange: (e) => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) apply(v); } }));
  return el("div", { class: "pxrow", title: "The picture's box in real video pixels: X and Y are its bottom left corner, measured from the bottom left of the frame (like the rulers), then its width and height. Type a value to place it exactly." },
    box("X px", b.left, (v) => ops.tf("x", (tg.tf.x ?? 0) + (v - b.left) / FW)),
    box("Y px ↑", b.bottom, (v) => ops.tf("y", (tg.tf.y ?? 0) + ((FH - v - b.h) - b.top) / FH)),
    box("W px", b.w, (v) => ops.tf("scale", clamp(sc * v / b.w, 0.1, 4))),
    box("H px", b.h, (v) => ops.tf("scale", clamp(sc * v / b.h, 0.1, 4))));
}

// ---------------------------------------------------------------------------
// Moving a clip between Video 1, 2 and 3: drag it up or down on the timeline (or use the Track buttons in Settings).
// Video 1 is the main track (clips follow each other); Video 2 and 3 are free layers on top of it.
// ---------------------------------------------------------------------------
function laneAtY(y) {                                    // which video row is the mouse over: 3, 2 or 1
  const r3_ = $("#trackV3").getBoundingClientRect(), r2 = $("#trackV2").getBoundingClientRect(), r1 = $("#trackVideo").getBoundingClientRect();
  if (y < r3_.bottom) return 3;
  if (y < r2.bottom) return 2;
  return y < (r2.bottom + r1.top) / 2 ? 2 : 1;
}
function markLane(ln) {                                  // highlight the row a drag would land on (0 = none)
  [[3, "#trackV3"], [2, "#trackV2"], [1, "#trackVideo"]].forEach(([n, id]) => $(id).classList.toggle("drop-on", n === ln));
}
const indexAtMontageTime = (t) => lay().items.filter((x) => !x.isOpener).reduce((n, it) => n + (t > it.start + it.duration / 2 ? 1 : 0), 0);
function clipToLayer(id, lane, dx = 0) {
  const c = findClip(id), it = lay().items.find((x) => x.clip.id === id);
  if (!c || !it) return;
  if (isLocked(c)) { toast("It's locked. Release the lock first (L)."); return; }
  const o = lay().openerSeconds, start = r3(Math.max(0, it.start - o + dx));
  const l = { id: newId("l"), lane, src: c.src, kind: c.kind, label: c.label, start, end: r3(start + it.duration), fit: c.fit === "contain" ? "contain" : "cover" };
  if (c.kind === "video") { l.in = c.in ?? 0; if (c.speed && c.speed !== 1) l.speed = c.speed; l.volume = c.volume ?? 0; }
  for (const k of ["transform", "crop", "adjust", "dim"]) if (c[k]) l[k] = clone(c[k]);
  commit((tl) => {
    tl.clips = tl.clips.filter((x) => x.id !== id);                       // the main track closes the gap
    if (c.group) { tl.groups = (tl.groups || []).filter((g) => tl.clips.some((x) => x.group === g.id)); if (!tl.groups.length) delete tl.groups; }
    tl.layers = [...(tl.layers || []), l];
    if (c.text?.value) tl.texts = [...(tl.texts || []), { id: newId("t"), value: c.text.value, start: l.start, end: l.end, position: c.text.position || "bottom", style: c.text.style || "pop" }];   // its caption stays as a normal text
  });
  S.multi = [], S.multiX = []; S.sel = { t: "layer", id: l.id }; renderAll(); seek(o + l.start + 0.01); toast(`Moved to Video ${lane}`);
}
function layerToClip(id, index) {
  const l = (S.tl.layers || []).find((x) => x.id === id);
  if (!l) return;
  const len = l.end - l.start, sp = l.speed || 1, m = mediaInfo(l.src);
  const c = { id: newId(), src: l.src, kind: l.kind, label: l.label || l.src.split("/").pop().replace(/\.[^.]+$/, ""), fit: l.fit === "contain" ? "contain" : "cover", motion: "none", transition: { type: "cut" } };
  if (l.kind === "image") c.hold = r3(len);
  else {
    c.in = r3(l.in || 0); c.out = r3(c.in + len * sp); c.speed = sp; c.volume = l.volume ?? 0;
    if (m?.duration) { c.source_duration = r3(m.duration); c.out = r3(Math.min(c.out, m.duration)); if (c.out <= c.in + 0.1) c.in = r3(Math.max(0, c.out - 0.2)); }
  }
  for (const k of ["transform", "crop", "adjust", "dim"]) if (l[k]) c[k] = clone(l[k]);
  commit((tl) => { tl.layers = tl.layers.filter((x) => x.id !== id); if (!tl.layers.length) delete tl.layers; tl.clips.splice(clamp(index, 0, tl.clips.length), 0, c); });
  S.multi = [], S.multiX = []; S.sel = { t: "clip", id: c.id }; renderAll();
  const it = lay().items.find((x) => x.clip.id === c.id); if (it) seek(it.start + 0.01);
  toast("Moved to Video 1");
}
function toggleClipSound(id) {
  const c = findClip(id); if (!c) return;
  commit((tl) => { const x = tl.clips.find((q) => q.id === id); x.volume = x.volume > 0 ? 0 : 1; });
  toast(findClip(id)?.volume > 0 ? "Clip sound on" : "Clip sound off");
}
function layerToLane(id, lane) { commit((tl) => { const l = tl.layers.find((x) => x.id === id); if (l) l.lane = lane; }); toast(`Moved to Video ${lane}`); }

function clipPointerDown(e, id) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const handle = e.target.dataset?.h;
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !handle) {   // ⌘/Ctrl-click: add or remove one clip from the picked set (any clips, not only a range)
    const cur = S.multi.length ? S.multi : (S.sel?.t === "clip" ? [S.sel.id] : []);
    S.multi = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    S.sel = S.multi.length ? { t: "clip", id: S.multi[S.multi.length - 1] } : null;
    renderAll(); return;
  }
  if (e.shiftKey && S.sel?.t === "clip" && S.sel.id !== id) {   // shift-click: pick the range from the selected clip to this one
    const a = clipIndex(S.sel.id), b = clipIndex(id);
    S.multi = S.tl.clips.slice(Math.min(a, b), Math.max(a, b) + 1).map((c) => c.id);
    renderAll(); return;
  }
  if (!handle && S.multi.length > 1 && S.multi.includes(id) && !isLocked(findClip(id))) return clipsBlockDrag(e, id);
  S.multi = [], S.multiX = [];
  S.sel = { t: "clip", id };
  if (isLocked(findClip(id))) {                // locked: select + jump to it, but no drag / trim
    const it = lay().items.find((x) => x.clip.id === id); if (it) seek(it.start + 0.01);
    renderAll(); return;
  }
  const startX = e.clientX, startY = e.clientY;
  const orig = clone(findClip(id));
  let moved = false, ghost = null, lastDx = 0;
  const pps = S.pps;
  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    if (!moved && Math.hypot(dx, ev.clientY - startY) < 4) return;       // a purely vertical drag counts too (up to Video 2 or 3)
    moved = true;
    const ds = dx / pps;
    if (handle) {
      commit((tl) => {
        const c = tl.clips.find((x) => x.id === id);
        if (c.kind === "image") {
          c.hold = r3(clamp((orig.hold ?? 2.5) + (handle === "r" ? ds : -ds), 0.3, 30));
        } else {
          const sp = c.speed || 1, max = orig.source_duration ?? Infinity;
          if (handle === "r") c.out = r3(clamp(orig.out + ds * sp, orig.in + 0.2 * sp, max));
          else c.in = r3(clamp(orig.in + ds * sp, 0, orig.out - 0.2 * sp));
        }
      }, "trim:" + id + handle);
      const it = lay().items.find((x) => x.clip.id === id);
      if (it) { S.time = handle === "r" ? Math.max(it.start, it.start + it.duration - 0.04) : it.start + 0.01; player?.seek(S.time); }
    } else {
      if (!ghost) {
        ghost = el("div", { class: "ghost-blk", style: { width: Math.min(160, clipLen(orig) * pps) + "px", backgroundImage: `url("${thumbUrl(orig.src)}")` } });
        document.body.append(ghost);
      }
      ghost.style.left = ev.clientX - 30 + "px"; ghost.style.top = ev.clientY - 27 + "px";
      lastDx = (ev.clientX - startX) / pps;
      const ln = laneAtY(ev.clientY);
      markLane(ln > 1 ? ln : 0);                                   // dragging up onto Video 2 or 3 lights that row
      if (ln > 1) hideDropMark(); else showDropMark(dropIndexAt(ev.clientX));
    }
  };
  const onUp = (ev) => {
    window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
    hideDropMark(); markLane(0);
    if (ghost && laneAtY(ev.clientY) > 1) { ghost.remove(); S.lastKey = null; clipToLayer(id, laneAtY(ev.clientY), lastDx); return; }
    if (ghost) {
      ghost.remove();
      let to = dropIndexAt(ev.clientX); const from = clipIndex(id);
      if (to > from) to -= 1;
      if (to !== from) commit((tl) => {
        const [c] = tl.clips.splice(from, 1); tl.clips.splice(to, 0, c);
        if (c.group) { const idx = tl.clips.map((x, i) => (x.group === c.group ? i : -1)).filter((i) => i >= 0); if (idx.length && (Math.min(...idx) !== idx[0] || Math.max(...idx) - Math.min(...idx) + 1 !== idx.length)) { const gg = (tl.groups || []).find((x) => x.id === c.group); delete c.group; if (gg) delete gg.seconds; } }
      });
    }
    if (!moved) { const it = lay().items.find((x) => x.clip.id === id); if (it) seek(it.start + 0.01); }
    S.lastKey = null; renderAll();
  };
  window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
  renderAll();
}

// ---------------------------------------------------------------------------
// Compound clips (groups)
// ---------------------------------------------------------------------------
function makeGroup(ids, name) {
  const idxs = ids.map(clipIndex).sort((a, b) => a - b);
  const gid = newId("g");
  commit((tl) => {
    tl.groups = tl.groups || [];
    tl.groups.push({ id: gid, name: name || "Group " + (tl.groups.length + 1) });
    for (const c of tl.clips.slice(idxs[0], idxs[idxs.length - 1] + 1)) c.group = gid;
  });
  S.multi = [], S.multiX = []; S.sel = { t: "group", id: gid }; renderAll(); toast("Grouped - type a name in the panel on the right");
}
function groupSelection() {
  const ids = S.multi.length > 1 ? S.multi : (S.sel?.t === "clip" ? [S.sel.id] : []);
  if (ids.length < 2) { toast("First click one clip, then SHIFT-click the last clip of the range (they turn purple), then press Group"); return; }
  makeGroup(ids, "");            // no browser prompt (blocked in some browsers): rename it in the panel on the right
}
function ungroup(gid) {
  commit((tl) => { for (const c of tl.clips) if (c.group === gid) delete c.group; tl.groups = (tl.groups || []).filter((g) => g.id !== gid); });
  if (S.sel?.t === "group") S.sel = null; renderAll();
}
// Drag the group bar (or a collapsed block): moves all its clips together to a new place.
function groupPointerDown(e, gid) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  S.sel = { t: "group", id: gid }; S.multi = [], S.multiX = [];
  const startX = e.clientX; let moved = false;
  if (groupOf(gid)?.locked) { const it = lay().items.find((x) => x.clip.group === gid); if (it) seek(it.start + 0.01); renderAll(); return; }
  if (e.target.dataset?.h === "r") {            // drag the right edge: change the fixed length
    const g0 = groupOf(gid), orig = g0.seconds;
    const mv = (ev) => commit((tl) => { tl.groups.find((x) => x.id === gid).seconds = r3(Math.max(0.5, Math.round((orig + (ev.clientX - startX) / S.pps) * 20) / 20)); }, "grp-len:" + gid);
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); S.lastKey = null; renderAll(); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); renderAll(); return;
  }
  const onMove = (ev) => { if (!moved && Math.abs(ev.clientX - startX) < 5) return; moved = true; showDropMark(dropIndexAt(ev.clientX)); };
  const onUp = (ev) => {
    window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); hideDropMark();
    if (moved) {
      const to = dropIndexAt(ev.clientX);
      commit((tl) => {
        const mem = tl.clips.filter((c) => c.group === gid); const rest = tl.clips.filter((c) => c.group !== gid);
        const before = tl.clips.slice(0, to).filter((c) => c.group !== gid).length;   // how many outside clips sit before the drop point
        rest.splice(before, 0, ...mem); tl.clips = rest;
      });
    } else { const it = lay().items.find((x) => x.clip.group === gid); if (it) seek(it.start + 0.01); }
    renderAll();
  };
  window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
  renderAll();
}
function groupInspector(g) {
  const mem = groupClips(g.id);
  const its = lay().items.filter((x) => x.clip.group === g.id);
  const dur = its.length ? its[its.length - 1].start + its[its.length - 1].duration - its[0].start : 0;
  return el("div", { class: "insp" },
    el("h3", {}, "▣ Compound clip"),
    el("div", { class: "sub" }, `${mem.length} clips · ${dur.toFixed(1)}s`),
    el("div", { class: "row" },
      field("Fixed length", el("div", { class: "btns" }, el("button", { class: g.seconds ? "on" : "", onclick: () => commit((tl) => { const gg = tl.groups.find((x) => x.id === g.id); if (gg.seconds) delete gg.seconds; else gg.seconds = r3(groupSpan(tl, g.id)?.len || 1); }) }, g.seconds ? "🔒 Locked" : "🔓 Free"))),
      g.seconds ? field("Length (s)", num(g.seconds, (v) => commit((tl) => { tl.groups.find((x) => x.id === g.id).seconds = r3(Math.max(0.5, v || 0.5)); }, "grp-len:" + g.id))) : null),
    field("Name", el("input", { type: "text", value: g.name, oninput: (e) => commit((tl) => { tl.groups.find((x) => x.id === g.id).name = e.target.value; }, "grp:" + g.id) })),
    el("div", { class: "btns" },
      el("button", { onclick: () => commit((tl) => { const gg = tl.groups.find((x) => x.id === g.id); gg.collapsed = !gg.collapsed; }) }, g.collapsed ? "▾ Open (expand)" : "▸ Collapse to one block"),
      el("button", { class: "danger", onclick: () => ungroup(g.id) }, "Ungroup")),
    el("div", { class: "hint" }, g.seconds ? "Locked: edits inside keep this length (the last clip absorbs the change), so nothing after the group moves. Drag the bar's right edge to change the length. " : "Lock the length to make it behave like one clip of a set size. "),
    el("div", { class: "hint" }, "Drag the purple bar to move the whole section. Collapse it to see it as one block. Click a single clip inside to edit it as usual."));
}

// ---------------------------------------------------------------------------
// Several things at once: drag a box on an empty part of the timeline to pick everything it touches, then drag one of them to move all.
// S.multi = picked clips on Video 1 (they move as a block in the order), S.multiX = picked texts, extra video layers and songs (they move in time).
// ---------------------------------------------------------------------------
const inX = (t, k) => S.multiX.some((x) => x.t === t && (t === "music" ? x.i === k : x.id === k));
const pickedCount = () => S.multi.length + S.multiX.length;
function startMarquee(e) {
  if (e.button !== 0) return;
  const inner = $("#tlInner"), add = e.shiftKey || e.metaKey || e.ctrlKey, x0 = e.clientX, y0 = e.clientY;
  const base = add ? { clips: S.multi.length ? [...S.multi] : S.sel?.t === "clip" ? [S.sel.id] : [], x: [...S.multiX] } : { clips: [], x: [] };
  let box = null, hits = [];
  const blocks = () => [...inner.querySelectorAll(".blk[data-pick]")];
  const mv = (ev) => {
    if (!box && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
    if (!box) { box = el("div", { class: "marquee" }); inner.append(box); }
    const r = inner.getBoundingClientRect(), l = Math.min(x0, ev.clientX), t = Math.min(y0, ev.clientY), w = Math.abs(ev.clientX - x0), h = Math.abs(ev.clientY - y0);
    Object.assign(box.style, { left: l - r.left + "px", top: t - r.top + "px", width: w + "px", height: h + "px" });
    hits = blocks().filter((b) => { const q = b.getBoundingClientRect(); return q.right > l && q.left < l + w && q.bottom > t && q.top < t + h; }).map((b) => b.dataset.pick);
    blocks().forEach((b) => b.classList.toggle("multi", hits.includes(b.dataset.pick)));
  };
  const up = (ev) => {
    window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
    if (!box) {                                                                  // just a click on an empty spot: deselect and jump there
      S.sel = null; S.multi = [], S.multiX = []; seek((ev.clientX - inner.getBoundingClientRect().left) / S.pps); renderAll(); return;
    }
    box.remove();
    const clips = [...new Set([...base.clips, ...hits.filter((h) => h.startsWith("clip:")).map((h) => h.slice(5))])];
    const xs = [...base.x];
    for (const h of hits) {
      const [t, k] = [h.slice(0, h.indexOf(":")), h.slice(h.indexOf(":") + 1)];
      if (t === "clip") continue;
      if (!inX(t, t === "music" ? +k : k) && !xs.some((x) => x.t === t && (t === "music" ? x.i === +k : x.id === k))) xs.push(t === "music" ? { t, i: +k } : { t, id: k });
    }
    S.multi = clips; S.multiX = xs;
    const last = xs[xs.length - 1];
    S.sel = clips.length ? { t: "clip", id: clips[clips.length - 1] } : last ? (last.t === "music" ? { t: "music", i: last.i } : { t: last.t, id: last.id }) : null;
    renderAll(); if (pickedCount()) toast(`${pickedCount()} picked. Drag one to move them all, ⌫ deletes them.`);
  };
  window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
}
// Move every picked text / layer / song together in time.
function groupDrag(e) {
  const sx = e.clientX, tl0 = clone(S.tl), pps = S.pps;
  const texts = (tl0.texts || []).filter((t) => inX("text", t.id) && !t.locked);
  const layers = (tl0.layers || []).filter((l) => inX("layer", l.id));
  const songs = S.multiX.filter((x) => x.t === "music").map((x) => ({ i: x.i, m: clone(musicAt(tl0, x.i)) })).filter((x) => x.m && !x.m.locked);
  const starts = [...texts.map((t) => t.start), ...layers.map((l) => l.start), ...songs.filter((x) => x.i > 0).map((x) => x.m.at || 0)];
  const floor = starts.length ? -Math.min(...starts) : -Infinity;
  let moved = false;
  const mv = (ev) => {
    if (!moved && Math.abs(ev.clientX - sx) < 4) return;
    moved = true;
    const ds = Math.max(floor, Math.round(((ev.clientX - sx) / pps) * 20) / 20);
    commit((tl) => {
      for (const o of texts) { const t = tl.texts.find((x) => x.id === o.id); t.start = r3(o.start + ds); t.end = r3(o.end + ds); }
      for (const o of layers) { const l = tl.layers.find((x) => x.id === o.id); l.start = r3(o.start + ds); l.end = r3(o.end + ds); }
      for (const { i, m: o } of songs) {
        const m = musicAt(tl, i);
        if (i === 0) { m.shift = r3((o.shift || 0) + ds); if (!m.shift) delete m.shift; }
        else { m.at = r3(Math.max(0, (o.at || 0) + ds)); if (o.until != null) m.until = r3(o.until + ds); }
      }
      if (songs.some((x) => x.i === 0) && tl.beats?.length) tl.beats = beatsFromSong(tl);
    }, "multi:move");
  };
  const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); S.lastKey = null; renderAll(); };
  window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
}
// Move the picked Video 1 clips as one block to where you drop them.
function clipsBlockDrag(e, id) {
  const ids = S.tl.clips.map((c) => c.id).filter((x) => S.multi.includes(x)), sx = e.clientX, sy = e.clientY;
  let ghost = null, moved = false;
  const mv = (ev) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
    moved = true;
    if (!ghost) { ghost = el("div", { class: "ghost-blk multi-ghost", style: { width: "120px", backgroundImage: `url("${thumbUrl(findClip(id).src)}")` } }, el("b", {}, String(ids.length))); document.body.append(ghost); }
    ghost.style.left = ev.clientX - 30 + "px"; ghost.style.top = ev.clientY - 27 + "px"; showDropMark(dropIndexAt(ev.clientX));
  };
  const up = (ev) => {
    window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); hideDropMark(); ghost?.remove();
    if (moved) {
      let to = dropIndexAt(ev.clientX);
      const before = ids.filter((x) => clipIndex(x) < to).length; to -= before;
      commit((tl) => { const pick = ids.map((x) => tl.clips.find((c) => c.id === x)); tl.clips = tl.clips.filter((c) => !ids.includes(c.id)); tl.clips.splice(clamp(to, 0, tl.clips.length), 0, ...pick); });
    } else { S.multi = [], S.multiX = []; S.sel = { t: "clip", id }; const it = lay().items.find((x) => x.clip.id === id); if (it) seek(it.start + 0.01); }
    S.lastKey = null; renderAll();
  };
  window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
}
function deleteMulti() {
  const songs = S.multiX.filter((x) => x.t === "music").map((x) => x.i).sort((a, b) => b - a);
  commit((tl) => {
    const drop = new Set(S.multi.filter((id) => !isLocked(tl.clips.find((c) => c.id === id))));
    tl.clips = tl.clips.filter((c) => !drop.has(c.id));
    const tx = new Set(S.multiX.filter((x) => x.t === "text").map((x) => x.id)); tl.texts = (tl.texts || []).filter((t) => !tx.has(t.id) || t.locked);
    const ly = new Set(S.multiX.filter((x) => x.t === "layer").map((x) => x.id)); if (tl.layers) { tl.layers = tl.layers.filter((l) => !ly.has(l.id)); if (!tl.layers.length) delete tl.layers; }
    for (const i of songs) {
      if (i > 0) { tl.music_more?.splice(i - 1, 1); if (tl.music_more && !tl.music_more.length) delete tl.music_more; }
      else if (tl.music_more?.length) { const nx = tl.music_more.shift(); nx.shift = nx.at || 0; delete nx.at; tl.music = nx; if (!tl.music_more.length) delete tl.music_more; }
      else tl.music = null;
    }
  });
  S.sel = null; S.multi = [], S.multiX = []; renderAll();
}

function textPointerDown(e, id) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const handle = e.target.dataset?.h;
  if (!handle && inX("text", id) && pickedCount() > 1) return groupDrag(e);
  S.multi = [], S.multiX = [];
  S.sel = { t: "text", id };
  const startX = e.clientX, orig = clone(S.tl.texts.find((t) => t.id === id));
  if (orig.locked) { renderAll(); return; }
  let moved = false;
  const onMove = (ev) => {
    const ds = (ev.clientX - startX) / S.pps;
    if (!moved && Math.abs(ev.clientX - startX) < 4) return;
    moved = true;
    commit((tl) => {
      const t = tl.texts.find((x) => x.id === id);
      if (handle === "l") t.start = r3(clamp(orig.start + ds, 0, orig.end - 0.3));
      else if (handle === "r") t.end = r3(Math.max(orig.start + 0.3, orig.end + ds));
      else { const d = orig.end - orig.start; t.start = r3(Math.max(0, orig.start + ds)); t.end = r3(t.start + d); }
    }, "text:" + id + (handle || "m"));
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
    if (!moved) { const L = lay(); seek(L.openerSeconds + window.MontagePlayer.textWindow(orig, L.items, L.openerSeconds).start + 0.01); }
    S.lastKey = null; renderAll();
  };
  window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
  renderAll();
}

// Drag the music block left/right: moves the song against the video (music.shift, in seconds).
function musicPointerDown(e, i = 0) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  if (!e.target.dataset?.h && inX("music", i) && pickedCount() > 1) return groupDrag(e);
  S.multi = [], S.multiX = [];
  S.sel = { t: "music", i };
  if (S.tl.music?.locked || S.tl.tracks?.["m" + (musicAt(S.tl, i)?.lane ?? 1)]?.lock) { renderAll(); return; }
  const startX = e.clientX, m0 = musicAt(S.tl, i), orig = i === 0 ? (m0.shift || 0) : (m0.at || 0), len0 = m0.until != null ? m0.until - (i === 0 ? 0 : (m0.at || 0)) : null;
  let moved = false;
  const handle = e.target.dataset?.h;
  if (handle) {                                           // drag an edge: trim the start or the end of the song, the sound stays in sync with the picture
    const sp0 = musicSpan(S.tl, i), off0 = m0.offset ?? 0, at0 = i === 0 ? (m0.shift || 0) : (m0.at || 0);
    const onTrim = (ev) => {
      const d = Math.round(((ev.clientX - startX) / S.pps) * 20) / 20;
      commit((tl) => {
        const m = musicAt(tl, i);
        if (handle === "r") { const t = r3(clamp(sp0.end + d, sp0.start + 0.5, sp0.max)); if (Math.abs(t - sp0.total) < 0.03) delete m.until; else m.until = t; }
        else {
          const dd = clamp(d, -Math.min(off0, Math.max(0, sp0.start)), sp0.end - sp0.start - 0.5);   // cannot start before the song itself or past its end
          if (i === 0) { m.shift = r3(at0 + dd); if (!m.shift) delete m.shift; } else m.at = r3(Math.max(0, at0 + dd));
          m.offset = r3(Math.max(0, off0 + dd)); if (!m.offset) delete m.offset;
          if (i === 0 && tl.beats?.length) tl.beats = beatsFromSong(tl);
        }
      }, "music:trim");
    };
    const onTrimUp = () => { window.removeEventListener("pointermove", onTrim); window.removeEventListener("pointerup", onTrimUp); S.lastKey = null; renderAll(); };
    window.addEventListener("pointermove", onTrim); window.addEventListener("pointerup", onTrimUp);
    renderAll(); return;
  }
  const onMove = (ev) => {
    if (!moved && Math.abs(ev.clientX - startX) < 4) return;
    moved = true;
    commit((tl) => {
      const m = musicAt(tl, i), v = r3(Math.round((orig + (ev.clientX - startX) / S.pps) * 20) / 20);   // 0.05 s steps
      if (i === 0) { m.shift = v; if (!m.shift) delete m.shift; }
      else { const d = Math.max(0, v) - (m.at || 0); m.at = Math.max(0, v); if (m.until != null) m.until = r3(m.until + d); }
      if (i === 0 && tl.beats?.length) tl.beats = beatsFromSong(tl);
    }, "music:shift");
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
    S.lastKey = null; renderAll();
  };
  window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
  renderAll();
}

function rulerSeek(e) {
  const rect = $("#tlInner").getBoundingClientRect();
  const go = (x) => seek((x - rect.left) / S.pps);
  go(e.clientX);
  const mv = (ev) => go(ev.clientX);
  const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
  window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function splitMusic() {
  const i = selMusic(), tl0 = S.tl, m0 = musicAt(tl0, i);
  if (!m0) return false;
  const opener = tl0.opener ? tl0.opener.seconds : 0, t = S.time - opener, sp = musicSpan(tl0, i);
  if (t <= sp.start + 0.3 || t >= sp.end - 0.3) { toast("Put the playhead inside the music block to cut it"); return true; }
  commit((tl) => {
    const m = musicAt(tl, i);
    const base = i === 0 ? (m.start_at === "opener" ? -opener : 0) + (m.shift || 0) : (m.at || 0);   // montage time at which the song position == offset
    const b = clone(m); delete b.shift; delete b.start_at; delete b.locked; delete b.until;
    b.at = r3(t); b.offset = r3(Math.max(0, (m.offset || 0) + (t - base)));
    b.fade_in = 0.4; if (m0.until != null) b.until = m0.until;
    m.until = r3(t); m.fade_out = Math.max(m.fade_out ?? 2, 1.2);
    tl.music_more = [...(tl.music_more || []), b];
  });
  S.sel = { t: "music", i: musicCount(S.tl) - 1 }; renderAll(); toast("Cut the music here - the first part fades out; click a song in the bin to put a different one after it");
  return true;
}
// Quick tools (CapCut style): act on the selected clip, or the clip under the playhead.
function quickTarget() {
  if (S.sel?.t === "layer") { const l = (S.tl.layers || []).find((x) => x.id === S.sel.id); if (l) return { kind: "layer", id: l.id, obj: l }; }
  if (S.sel?.t === "clip") { const c = findClip(S.sel.id); if (c) return { kind: "clip", id: c.id, obj: c }; }
  const it = lay().items.find((x) => !x.isOpener && S.time >= x.start && S.time < x.start + x.duration);
  if (it) { S.sel = { t: "clip", id: it.clip.id }; return { kind: "clip", id: it.clip.id, obj: it.clip }; }
  toast("Click a clip first"); return null;
}
const quickObj = (tl, t) => (t.kind === "clip" ? tl.clips.find((c) => c.id === t.id) : (tl.layers || []).find((l) => l.id === t.id));
// Expand: give back what was cut away. Back to the in/out the clip had before it was split; with no cut recorded, the whole video.
function quickExpand() {
  const t = quickTarget(); if (!t) return;
  const c = quickObj(S.tl, t);
  if (!c || c.kind === "image") { toast("Pick a video clip"); return; }
  const full = { in: 0, out: c.source_duration ?? mediaInfo(c.src)?.duration ?? c.out };
  const grow = (to) => ({ nin: r3(Math.min(c.in, to.in)), nout: r3(Math.max(c.out, to.out)) });
  let g = grow(c.cut_from || full), msg = c.cut_from ? "Expanded to where it was cut" : "Expanded to the whole video";
  if (g.nin === r3(c.in) && g.nout === r3(c.out) && c.cut_from) { g = grow(full); msg = "Expanded to the whole video"; }   // already back at the cut: the next press gives the whole video
  if (g.nin === r3(c.in) && g.nout === r3(c.out)) { toast("Nothing more to give back: this is the whole video"); return; }
  commit((tl) => { const x = quickObj(tl, t); x.in = g.nin; x.out = g.nout; if (msg.endsWith("video")) delete x.cut_from; });
  renderAll(); toast(msg);
}
function quickFlip(vertical) {
  const t = quickTarget(); if (!t) return;
  const k = vertical ? "v" : "h";
  commit((tl) => { const o = quickObj(tl, t), f = { ...(o.flip || {}) }; if (f[k]) delete f[k]; else f[k] = true; if (Object.keys(f).length) o.flip = f; else delete o.flip; });
  renderAll(); toast(vertical ? "Flipped upside down" : "Flipped");
}
function quickRotate() {
  const t = quickTarget(); if (!t) return;
  if (t.kind === "clip") commit((tl) => { const o = quickObj(tl, t); const r = (((o.rotate || 0) + 90) % 360); if (r) o.rotate = r; else delete o.rotate; });
  else commit((tl) => { const o = quickObj(tl, t); o.transform = { ...(o.transform || {}), rotate: ((o.transform?.rotate || 0) + 90) % 360 }; });
  renderAll();
}
async function quickReverse() {
  const t = quickTarget(); if (!t) return;
  if (t.kind !== "clip") { toast("Reverse works on Video 1 clips"); return; }
  const c = t.obj;
  if (c.kind !== "video") { toast("Reverse is for videos"); return; }
  if (isLocked(c)) { toast("It's locked - release the lock first (L)"); return; }
  if (c.reversed) {                                    // second click: back to the original
    const o = c.reversed;
    commit((tl) => { const x = quickObj(tl, t); x.src = o.src; x.in = o.in; x.out = o.out; if (o.source_duration) x.source_duration = o.source_duration; delete x.reversed; });
    renderAll(); toast("Back to forwards"); return;
  }
  toast("Reversing...");
  let r;
  try {
    r = await api("/reverse", { method: "POST", body: JSON.stringify({ src: c.src, start: c.in, end: c.out }) });
  } catch (e) { toast(String(e.message || e)); return; }
  const was = { src: c.src, in: c.in, out: c.out, ...(c.source_duration ? { source_duration: c.source_duration } : {}) };
  commit((tl) => { const x = quickObj(tl, t); x.reversed = was; x.src = r.src; x.in = 0; x.out = r3(r.duration); x.source_duration = r3(r.duration); });
  renderAll(); toast("Reversed");
}
function quickCrop() {
  const t = quickTarget(); if (!t) return;
  const L = lay(), it = t.kind === "clip" ? L.items.find((x) => x.clip.id === t.id) : null;
  if (it && !(S.time >= it.start && S.time < it.start + it.duration)) seek(it.start + 0.01);
  S.xfMode = "crop"; renderAll(); toast("Drag the white squares on the picture to crop");
}

function splitAtPlayhead() {
  if (S.sel?.t === "music" && splitMusic()) return;
  const it = lay().items.find((x) => !x.isOpener && S.time > x.start + 0.15 && S.time < x.start + x.duration - 0.15);
  if (!it) { toast("Put the playhead inside a clip to split"); return; }
  const c = clone(it.clip), off = S.time - it.start;  // copy: commit() mutates the live clip
  const b = clone(c); b.id = newId(); b.transition = { type: "cut" }; delete b.text;
  commit((tl) => {
    const a = tl.clips.find((x) => x.id === c.id);
    if (a.kind === "image") { a.hold = r3(off); b.hold = r3((c.hold ?? 2.5) - off); }
    else { const t = r3(c.in + off * (c.speed || 1)); const was = c.cut_from || { in: c.in, out: c.out }; a.cut_from = { ...was }; b.cut_from = { ...was }; a.out = t; b.in = t; }
    tl.clips.splice(clipIndex(c.id) + 1, 0, b);
  });
  S.sel = { t: "clip", id: b.id }; renderAll(); toast("Split");
}
function deleteSelection() {
  if (S.multi.length > 1 || S.multiX.length > 1 || (S.multi.length && S.multiX.length)) { deleteMulti(); return; }
  if (!S.sel) return;
  const lockedSel = (S.sel.t === "clip" && isLocked(findClip(S.sel.id))) || (S.sel.t === "text" && S.tl.texts.find((t) => t.id === S.sel.id)?.locked) || (S.sel.t === "music" && S.tl.music?.locked) || (S.sel.t === "group" && groupOf(S.sel.id)?.locked);
  if (lockedSel) { toast("It's locked - release the lock first (L)"); return; }
  if (S.sel.t === "clip") commit((tl) => { tl.clips = tl.clips.filter((c) => c.id !== S.sel.id); });
  else if (S.sel.t === "text") commit((tl) => { tl.texts = (tl.texts || []).filter((t) => t.id !== S.sel.id); });
  else if (S.sel.t === "layer") { const lid = S.sel.id; commit((tl) => { tl.layers = (tl.layers || []).filter((l) => l.id !== lid); if (!tl.layers.length) delete tl.layers; }); }
  else if (S.sel.t === "music") {
    const i = selMusic();
    commit((tl) => {
      if (i > 0) { tl.music_more.splice(i - 1, 1); if (!tl.music_more.length) delete tl.music_more; }
      else if (tl.music_more?.length) { const nx = tl.music_more.shift(); nx.shift = nx.at || 0; delete nx.at; tl.music = nx; if (!tl.music_more.length) delete tl.music_more; }
      else tl.music = null;
    });
  }
  else if (S.sel.t === "group") { const gid = S.sel.id; commit((tl) => { tl.clips = tl.clips.filter((c) => c.group !== gid); tl.groups = (tl.groups || []).filter((g) => g.id !== gid); }); }
  S.sel = null; renderAll();
}
function duplicateClip(id) {
  const c = clone(findClip(id)); c.id = newId();
  commit((tl) => {
    tl.clips.splice(clipIndex(id) + 1, 0, c);
    const own = (tl.texts || []).filter((x) => x.follow === id);   // subtitles and headlines stuck to the clip come along
    if (own.length) tl.texts = [...tl.texts, ...own.map((x) => ({ ...clone(x), id: newId("t"), follow: c.id }))];
  });
  S.sel = { t: "clip", id: c.id }; renderAll();
}
function addText() {
  const t0 = Math.max(0, S.time - lay().openerSeconds);
  const t = { id: newId("t"), value: "Your text", start: r3(t0), end: r3(t0 + 2), position: "center", style: "title" };
  commit((tl) => { tl.texts = [...(tl.texts || []), t]; });
  S.sel = { t: "text", id: t.id }; renderAll();
  setTimeout(() => $("#insp-text-value")?.select(), 0);
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------
// Three-dot menus: the less used buttons live in a small list under each section's ⋮ button.
function initMenus() {
  const closeAll = () => document.querySelectorAll(".menu").forEach((m) => m.classList.add("hidden"));
  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".menu-btn");
    if (btn) {
      const menu = btn.parentElement.querySelector(".menu"), wasOpen = !menu.classList.contains("hidden");
      closeAll();
      if (!wasOpen) {
        menu.classList.remove("hidden");
        const r = btn.getBoundingClientRect(), w = menu.offsetWidth;
        menu.style.top = `${r.bottom + 6}px`; menu.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
      }
      return;
    }
    if (!e.target.closest?.(".menu") || e.target.closest(".menu button, .menu a")) setTimeout(closeAll, 0);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });
}
initMenus();

// Background behind the person: blur it or replace it. Makes a new video of just this cut (on this Mac), the original is kept.
function bgSection(c) {
  const cur = c.bgfx || {}, ui = (S.bgUI = S.bgUI || {});
  if (ui.id !== c.id) Object.assign(ui, { id: c.id, mode: cur.mode && cur.mode !== "none" ? cur.mode : "blur", amount: cur.amount ?? 30, color: cur.color || "#00b140", image: cur.image || "" });
  const bgMedia = S.media.filter((m) => !m.src.includes("cuts-bank") && !m.src.includes("/fx/") && m.kind !== "audio");
  return el("div", { class: "sec" }, el("div", { class: "sec-t" }, "Background"),
    cur.status === "done" ? el("div", { class: "hint" }, `Now: ${cur.mode}${cur.mode === "blur" ? " " + cur.amount + "%" : ""}`) : null,
    field("Effect", select(["blur", "color", "image"], ui.mode, (v) => { ui.mode = v; renderInspector(true); }, ["Blur the background", "Solid colour", "Photo or video"])),
    ui.mode === "blur" ? field("Blur", range(ui.amount, 0, 100, 1, (v) => { ui.amount = v; }), `${ui.amount}%`) : null,
    ui.mode === "color" ? field("Colour", el("input", { type: "color", value: ui.color, oninput: (e) => { ui.color = e.target.value; } })) : null,
    ui.mode === "image" ? field("Picture or video", select(["", ...bgMedia.map((m) => m.src)], ui.image, (v) => { ui.image = v; }, ["Choose from the media bin", ...bgMedia.map((m) => m.name)])) : null,
    el("div", { class: "btns" },
      el("button", { class: "primary", onclick: () => runBgFx(c.id, { mode: ui.mode, amount: ui.amount, color: ui.color, image: ui.image }) }, "Apply"),
      cur.status === "done" ? el("button", { onclick: () => runBgFx(c.id, { mode: "none" }) }, "Remove effect") : null),
    el("div", { class: "hint" }, "Takes about as long as the clip. The original cut is kept."));
}
let bgBusy = false;
// While an AI change is under review: make the background now and show it in the preview (nothing is saved until Approve).
async function previewPendingBgFx() {
  const p = S.chat.pending; if (!p || bgBusy) return;
  for (const c of S.tl.clips.filter((x) => x.bgfx && x.bgfx.status !== "done")) {
    bgBusy = true;
    const box = $("#renderStatus");
    try {
      let j = await api("/bgfx", { method: "POST", body: JSON.stringify({ clip: c.id, dry: true, clip_json: c, mode: c.bgfx.mode || "blur", amount: c.bgfx.amount, color: c.bgfx.color, image: c.bgfx.image }) });
      while (j.running) {
        box.replaceChildren(el("span", {}, `Making the preview ${Math.round((j.progress || 0) * 100)}%`), el("div", { class: "bar" }, el("i", { style: { width: `${(j.progress || 0) * 100}%` } })));
        await new Promise((r) => setTimeout(r, 800));
        j = await api("/bgfx");
      }
      box.replaceChildren();
      if (!j.ok) throw new Error(j.error || "failed");
      if (S.chat.pending !== p) { bgBusy = false; return; }   // rejected or replaced meanwhile
      await loadMedia().catch(() => {});
      for (const t of [S.tl, p.proposal]) {
        const tgt = t.clips.find((x) => x.id === c.id); if (!tgt) continue;
        for (const [k, v] of Object.entries(j.patch)) { if (v === null) delete tgt[k]; else tgt[k] = v; }
      }
      changed({ save: false });
      toast("Background preview ready. Approve to keep it.");
    } catch (e) { box.replaceChildren(); toast(`Background preview failed: ${e.message}`); }
    bgBusy = false;
  }
}
async function runBgFx(clipId, fx) {
  if (bgBusy) { toast("A background effect is already running"); return; }
  if (fx.mode === "image" && !fx.image) { toast("Choose a picture or video first"); return; }
  bgBusy = true;
  const box = $("#renderStatus");
  try {
    if (S.dirty) await save();
    let j = await api("/bgfx", { method: "POST", body: JSON.stringify({ clip: clipId, ...fx }) });
    while (j.running) {
      box.replaceChildren(el("span", {}, `Background ${Math.round((j.progress || 0) * 100)}%`), el("div", { class: "bar" }, el("i", { style: { width: `${(j.progress || 0) * 100}%` } })));
      await new Promise((r) => setTimeout(r, 800));
      j = await api("/bgfx");
    }
    box.replaceChildren();
    if (!j.ok) throw new Error(j.error || "failed");
    await loadMedia().catch(() => {});
    await refreshFromDisk();
    toast(fx.mode === "none" ? "Background effect removed" : "Background done 🎉");
  } catch (e) { box.replaceChildren(); toast(`Background failed: ${e.message}`); }
  bgBusy = false;
}
// The AI chat asks for an effect by setting clips/<id>/bgfx {status:"todo"}; after Approve the editor makes it.
async function runPendingBgFx() {
  for (const c of S.tl.clips) {
    if (c.bgfx && c.bgfx.status !== "done") {
      const fx = { mode: c.bgfx.mode || "blur", amount: c.bgfx.amount, color: c.bgfx.color, image: c.bgfx.image };
      await runBgFx(c.id, fx);
    }
  }
}
function field(label, input, val) { return el("div", { class: "f" }, el("label", {}, label, val != null ? el("span", { class: "val" }, val) : null), input); }
function select(options, value, onchange, labels) {
  const s = el("select", { onchange: (e) => onchange(e.target.value) }, ...options.map((o, i) => el("option", { value: o, selected: String(o) === String(value) }, labels ? labels[i] : o)));
  return s;
}
function num(value, onchange, attrs = {}) { return el("input", { type: "number", step: "0.1", value: value ?? "", ...attrs, onchange: (e) => onchange(parseFloat(e.target.value)) }); }
function range(value, min, max, step, oninput) { return el("input", { type: "range", min, max, step, value, oninput: (e) => oninput(parseFloat(e.target.value)) }); }
function chips(options, value, onpick) { return el("div", { class: "chip-row" }, ...options.map((o) => el("button", { class: o === value ? "on" : "", onclick: () => onpick(o) }, o))); }
const setClip = (id, key) => (fn) => commit((tl) => fn(tl.clips.find((c) => c.id === id)), key ? `clip:${id}:${key}` : null);

function renderInspector(force = false) {
  const box = $("#inspector");
  if (!S.tl) { box.replaceChildren(); return; }
  // Don't rebuild while the user is typing or dragging a slider in it.
  const a = document.activeElement;
  if (!force && a && box.contains(a) && ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName)) return;
  if (S.sel?.t === "clip") { const c = findClip(S.sel.id); const gl = !!(c.group && groupOf(c.group)?.locked);
    return box.replaceChildren(gl ? withLock(clipInspector(c), true, () => toggleLock("group", c.group), "group") : withLock(clipInspector(c), !!c.locked, () => toggleLock("clip", c.id), "clip")); }
  if (S.sel?.t === "group") { const g = groupOf(S.sel.id); if (g) return box.replaceChildren(withLock(groupInspector(g), !!g.locked, () => toggleLock("group", g.id), "group")); }
  if (S.sel?.t === "text") { const t = S.tl.texts.find((x) => x.id === S.sel.id); return box.replaceChildren(withLock(textInspector(t), !!t.locked, () => toggleLock("text", t.id), "text")); }
  if (S.sel?.t === "layer") { const l = (S.tl.layers || []).find((x) => x.id === S.sel.id); if (l) return box.replaceChildren(layerInspector(l)); }
  if (S.sel?.t === "music") return box.replaceChildren(withLock(musicInspector(), !!S.tl.music?.locked, () => toggleLock("music"), "music"));
  box.replaceChildren(projectInspector());
}

function clipInspector(c) {
  const upd = setClip(c.id);
  const it = lay().items.find((x) => x.clip.id === c.id);
  const isVid = c.kind === "video";
  const tr = c.transition || { type: "cut" };
  const src = mediaInfo(c.src);
  return el("div", { class: "insp" },
    el("img", { class: "thumb", src: thumbUrl(c.src, 640) }),
    el("h3", {}, c.label || c.src.split("/").pop()),
    el("div", { class: "sub" }, `${c.src} · ${isVid ? "video" : "photo"} · on screen ${clipLen(c).toFixed(2)}s`),
    c.generated ? motionInspector(c) : null,
    field("Track", chips(["Video 1", "Video 2", "Video 3"], "Video 1", (v) => { if (v !== "Video 1") clipToLayer(c.id, parseInt(v.slice(-1)), 0); })),

    el("div", { class: "sec" }, el("div", { class: "sec-t" }, isVid ? "Trim" : "Duration"),
      isVid ? [
        el("div", { class: "row" },
          field("Start (s)", num(c.in, (v) => upd((x) => { x.in = r3(clamp(v, 0, x.out - 0.1)); }))),
          field("End (s)", num(c.out, (v) => upd((x) => { x.out = r3(clamp(v, x.in + 0.1, x.source_duration ?? src?.duration ?? 1e9)); })))),
        el("div", { class: "btns" },
          el("button", { onclick: () => { if (!it) return; const t = c.in + (S.time - it.start) * (c.speed || 1); upd((x) => { x.in = r3(clamp(t, 0, x.out - 0.1)); }); } }, "Start ⇤ playhead"),
          el("button", { onclick: () => { if (!it) return; const t = c.in + (S.time - it.start) * (c.speed || 1); upd((x) => { x.out = r3(clamp(t, x.in + 0.1, x.source_duration ?? 1e9)); }); } }, "End ⇥ playhead")),
        el("div", { class: "hint" }, `Source length ${fmt(c.source_duration ?? src?.duration ?? 0)}. Or drag the clip edges on the timeline.`),
      ] : field("Seconds on screen", num(c.hold ?? 2.5, (v) => upd((x) => { x.hold = r3(clamp(v || 2.5, 0.3, 30)); })))),

    isVid ? el("div", { class: "sec" }, el("div", { class: "sec-t" }, "Speed & sound"),
      field("Speed", chips(SPEEDS.map(String), String(c.speed || 1), (v) => upd((x) => { x.speed = parseFloat(v); }))),
      field("Clip sound (dB)", dbLevel(c, 0, (v) => setClip(c.id, "vol")((x) => { x.volume = v; }))),
      volLineSection(c, () => setClip(c.id)((x) => { delete x.vol; })),
      el("div", { class: "hint" }, "Music gets quieter automatically while a clip plays its own sound.")) : null,

    el("div", { class: "sec", id: "insp-trans" }, el("div", { class: "sec-t" }, "Transition in"),
      chips(TRANSITIONS, tr.type, (v) => upd((x) => { x.transition = { type: v, seconds: x.transition?.seconds || 0.35 }; })),
      tr.type !== "cut" ? field("Length", range(tr.seconds ?? 0.35, 0.1, 1.5, 0.05, (v) => setClip(c.id, "ts")((x) => { x.transition = { ...x.transition, seconds: v }; })), `${(tr.seconds ?? 0.35).toFixed(2)}s`) : null),

    el("div", { class: "sec" }, el("div", { class: "sec-t" }, "Look"),
      field("Motion", chips(MOTIONS, c.motion || "none", (v) => upd((x) => { x.motion = v; }))),
      field("Clip shape", chips(CLIP_SHAPES, null, (v) => upd((x) => applyClipShape(x, v)))),
      el("div", { class: "hint" }, "Pick where this clip is going. Its picture is cropped to that shape and centred in the video. Fine-tune with Position & crop below."),
      field("Fit", chips(FITS, c.fit || "cover", (v) => upd((x) => { x.fit = v; }))),
      field("Rotate", el("div", { class: "btns" },
        el("button", { title: "Rotate 90° counter-clockwise", onclick: () => upd((x) => { x.rotate = (((x.rotate || 0) - 90) % 360 + 360) % 360; if (!x.rotate) delete x.rotate; }) }, "⟲ 90°"),
        el("button", { title: "Rotate 90° clockwise", onclick: () => upd((x) => { x.rotate = ((x.rotate || 0) + 90) % 360; if (!x.rotate) delete x.rotate; }) }, "⟳ 90°"),
        el("button", { title: "Flip upside down", onclick: () => upd((x) => { x.rotate = ((x.rotate || 0) + 180) % 360; if (!x.rotate) delete x.rotate; }) }, "↕ 180°")), `${c.rotate || 0}°`),
      field("Zoom in", range(c.zoom ?? 1, 1, 3, 0.05, (v) => setClip(c.id, "zoom")((x) => { if (v > 1) x.zoom = r3(v); else delete x.zoom; })), `${(c.zoom ?? 1).toFixed(2)}×`),
      el("div", { class: "row" },
        field("Focus ↔", range(c.focus?.x ?? 0.5, 0, 1, 0.01, (v) => setClip(c.id, "fx")((x) => { x.focus = { ...(x.focus || {}), x: v }; }))),
        field("Focus ↕", range(c.focus?.y ?? 0.5, 0, 1, 0.01, (v) => setClip(c.id, "fy")((x) => { x.focus = { ...(x.focus || {}), y: v }; }))))),

    frameSection(c, { tf: (k, v) => setClip(c.id, "tf" + k)((x) => setTf(x, k, v)), crop: (k, v) => setClip(c.id, "cr" + k)((x) => setCrop(x, k === null ? { l: 0, t: 0, r: 0, b: 0 } : { [k]: v })) }, TF_PRESETS_CLIP,
      field("Open space colour", el("div", { class: "row" },
        el("input", { type: "color", value: c.bg || "#000000", oninput: (e) => setClip(c.id, "bg")((x) => { x.bg = e.target.value; }) }),
        el("button", { onclick: () => upd((x) => { delete x.bg; }) }, "Project colour")))),

    adjustSection(c.adjust || {}, (k, v) => setClip(c.id, "adj" + k)((x) => setAdjust(x, k, v)), () => upd((x) => { delete x.adjust; })),

    c.kind === "video" ? bgSection(c) : null,

    el("div", { class: "sec" }, el("div", { class: "sec-t" }, "Text on this clip"),
      field("Text", el("textarea", { placeholder: "e.g. יוצאים לדרך!", oninput: (e) => setClip(c.id, "txt")((x) => {
        const v = e.target.value; if (v) x.text = { position: "bottom", style: "pop", ...(x.text || {}), value: v }; else delete x.text;
      }) }, c.text?.value || "")),
      c.text ? [field("Style", chips(TEXT_STYLES, c.text.style || "pop", (v) => upd((x) => { x.text.style = v; }))),
        field("Position", chips(POSITIONS, c.text.position || "bottom", (v) => upd((x) => { x.text.position = v; })))] : null),

    el("div", { class: "sec" },
      el("div", { class: "btns" },
        el("button", { onclick: splitAtPlayhead }, "✂ Split"),
        el("button", { onclick: () => duplicateClip(c.id) }, "⧉ Duplicate"),
        el("button", { class: "danger", onclick: deleteSelection }, "🗑 Delete"))),
  );
}

// A text that sticks to a clip moves with it (start/end become seconds from that clip's start).
function stickText(id) {
  commit((tl) => {
    const t = tl.texts.find((x) => x.id === id), L = window.MontagePlayer.layoutTimeline(tl), op = L.opener_seconds ?? L.openerSeconds ?? 0;
    if (t.follow) { const w = window.MontagePlayer.textWindow(t, L.items, op); t.start = r3(w.start); t.end = r3(w.end); delete t.follow; return; }
    const it = L.items.find((x) => !x.isOpener && x.start - op <= t.start + 0.001 && x.start - op + x.duration > t.start) || L.items.find((x) => !x.isOpener);
    t.follow = it.clip.id; const base = it.start - op; t.start = r3(t.start - base); t.end = r3(t.end - base);
  });
  renderAll();
}
function textInspector(t) {
  const upd = (key) => (fn) => commit((tl) => fn(tl.texts.find((x) => x.id === t.id)), key ? `text:${t.id}:${key}` : null);
  return el("div", { class: "insp" },
    el("h3", {}, "Text"),
    el("div", { class: "sub" }, t.follow ? `Sticks to clip ${findClip(t.follow)?.label || t.follow}: ${fmt(t.start)} → ${fmt(t.end)} after that clip starts` : `${fmt(t.start)} → ${fmt(t.end)} (after the opener)`),
    el("div", { class: "btns" }, el("button", { onclick: () => stickText(t.id) }, t.follow ? "⛓ Unstick from clip" : "⛓ Stick to the clip under it")),
    field("Text", el("textarea", { id: "insp-text-value", oninput: (e) => upd("v")((x) => { x.value = e.target.value || " "; }) }, t.value)),
    el("div", { class: "row" },
      field("Start", num(t.start, (v) => upd()((x) => { x.start = r3(clamp(v, 0, x.end - 0.2)); }))),
      field("End", num(t.end, (v) => upd()((x) => { x.end = r3(Math.max(x.start + 0.2, v)); })))),
    field("Style", chips(TEXT_STYLES, t.style || "title", (v) => upd()((x) => { x.style = v; }))),
    field("Position", chips(POSITIONS, t.position || "center", (v) => upd()((x) => { x.position = v; }))),
    el("div", { class: "btns" }, el("button", { class: "danger", onclick: deleteSelection }, "🗑 Delete text")));
}

// Beats: detected on the song's clock (S.songBeats), mapped onto the montage clock in tl.beats.
function beatsFromSong(tl) {
  const sb = S.songBeats, m = tl.music;
  if (!m || !sb || sb.src !== m.src) return [];
  const opener = tl.opener ? tl.opener.seconds : 0;
  const shift = (m.offset || 0) + (m.start_at === "opener" ? opener : 0) - (m.shift || 0);
  return sb.times.map((t) => r3(t - shift)).filter((t) => t >= 0);
}
async function detectBeats(force = false) {
  const m = S.tl.music; if (!m || S.beatsBusy) return;
  S.beatsBusy = true; renderInspector(true);
  try {
    const r = await api("/beats", { method: "POST", body: JSON.stringify({ src: m.src, force }) });
    S.songBeats = r.beats;
    commit((tl) => { tl.beats = beatsFromSong(tl); });
    toast(`${r.beats.bpm ? Math.round(r.beats.bpm) + " BPM · " : ""}${r.beats.count} beats found`);
  } catch (e) { toast(e.message); }
  S.beatsBusy = false; renderInspector(true);
}
async function snapToBeats() {
  if (!S.tl.beats?.length) return;
  try {
    const r = await api("/snap-beats", { method: "POST", body: JSON.stringify({ timeline: S.tl, tolerance: S.snapTol ?? 0.4 }) });
    const before = lay().total;
    commit((tl) => { for (const k of Object.keys(tl)) delete tl[k]; Object.assign(tl, r.timeline); });
    toast(`Cuts snapped to the beat (length ${fmt(before)} → ${fmt(lay().total)})`);
  } catch (e) { toast(e.message); }
}
function beatsSection(m) {
  if (S.songBeats?.src !== m.src && !(S.beatsChecked ||= {})[m.src]) { // pick up saved detection after a reload
    S.beatsChecked[m.src] = true;
    api("/beats").then((r) => { if (r.beats && S.tl.music?.src === r.beats.src) { S.songBeats = r.beats; renderInspector(true); } }).catch(() => {});
  }
  const sb = S.songBeats?.src === m.src ? S.songBeats : null;
  const n = S.tl.beats?.length || 0;
  return el("div", { class: "sec" }, el("div", { class: "sec-t" }, "Beats"),
    el("div", { class: "hint" }, sb ? `${sb.bpm ? Math.round(sb.bpm) + " BPM · " : ""}${sb.count} beats in the song, ${n} on the timeline` : n ? `${n} beats on the timeline (from an older detection)` : "No beats yet."),
    el("div", { class: "btns" },
      el("button", { disabled: S.beatsBusy, onclick: () => detectBeats(!!sb) }, S.beatsBusy ? "Listening…" : sb ? "Detect again" : "♪ Detect beats"),
      n ? el("button", { class: "danger", onclick: () => commit((tl) => { tl.beats = []; }) }, "Clear") : null),
    n ? [field("Snap range", range(S.snapTol ?? 0.4, 0.1, 0.8, 0.05, (v) => { S.snapTol = v; }), `±${(S.snapTol ?? 0.4).toFixed(2)}s`),
      el("div", { class: "btns" }, el("button", { class: "primary", onclick: snapToBeats }, "Snap cuts to beats")),
      el("div", { class: "hint" }, "Moves each clip's end onto the nearest beat. Undo with ⌘Z. Turn on Beat pulse in Video settings to make the picture bounce on the beat.")] : null);
}

function musicInspector() {
  const i = selMusic(), m = musicAt(S.tl, i), sp = musicSpan(S.tl, i);
  const upd = (key) => (fn) => commit((tl) => fn(musicAt(tl, i)), key ? `music${i}:${key}` : null);
  const songs = S.media.filter((x) => x.kind === "audio");
  const n = musicCount(S.tl);
  return el("div", { class: "insp" },
    el("h3", {}, n > 1 ? `♫ Song ${i + 1} of ${n}` : "♫ Music"),
    el("div", { class: "sub" }, `${m.src.split("/").pop().replace(/\.[^.]+$/, "")} · starts ${fmt(lay().openerSeconds + sp.start)} · ends ${fmt(lay().openerSeconds + sp.end)} on the video`),
    el("div", { class: "btns" }, el("button", { class: "primary", onclick: () => { if (!splitMusic()) toast("Select the music first"); } }, "✂ Cut the song at the playhead")),
    field("Channel", chips(["1", "2", "3"], String(laneOf(m)), (v) => commit((tl) => { const mm = musicAt(tl, i); if (v === "1") delete mm.lane; else mm.lane = parseInt(v); }))),
    field("Replace this song with…", select(songs.map((s) => s.src), m.src, (v) => commit((tl) => { musicAt(tl, i).src = v; if (i === 0) { tl.beats = []; S.songBeats = null; } }))),
    field("Ends at (s) — the music stops here and fades out. Past the last clip, the movie runs on until the music ends", num(m.until ?? r3(sp.total), (v) => commit((tl) => { const mm = musicAt(tl, i); const t = r3(Math.min(sp.max, Math.max(sp.start + 1, v || 0))); if (Math.abs(t - sp.total) < 0.03) delete mm.until; else mm.until = t; }, `music${i}:until`))),
    i === 0
      ? field("Move music (s) — or drag it on the timeline", num(m.shift ?? 0, (v) => commit((tl) => { const mm = tl.music; mm.shift = r3(clamp(v || 0, -600, 600)); if (!mm.shift) delete mm.shift; if (tl.beats?.length) tl.beats = beatsFromSong(tl); }, "music:shift")), "− sooner · + later")
      : field("Starts at (s)", num(m.at ?? 0, (v) => commit((tl) => { const mm = musicAt(tl, i); const d = Math.max(0, v || 0) - (mm.at || 0); mm.at = r3(Math.max(0, v || 0)); if (mm.until != null) mm.until = r3(mm.until + d); }, `music${i}:at`))),
    field("Start the song at (s)", num(m.offset ?? 0, (v) => commit((tl) => { musicAt(tl, i).offset = r3(Math.max(0, v || 0)); if (i === 0 && tl.beats?.length) tl.beats = beatsFromSong(tl); }))),
    field("Volume (dB)", dbLevel(m, 0.8, (v) => upd("vol")((x) => { x.volume = v; }))),
    volLineSection(m, () => upd()((x) => { delete x.vol; })),
    field("Volume under clip sound", range(m.duck_volume ?? 0.25, 0, 1, 0.05, (v) => upd("duck")((x) => { x.duck_volume = v; })), `${Math.round((m.duck_volume ?? 0.25) * 100)}%`),
    el("div", { class: "row" },
      field("Fade in (s)", num(m.fade_in ?? 0.5, (v) => upd()((x) => { x.fade_in = Math.max(0, v || 0); }))),
      field("Fade out (s)", num(m.fade_out ?? 2, (v) => upd()((x) => { x.fade_out = Math.max(0, v || 0); })))),
    i === 0 ? field("Starts with", chips(["clips", "opener"], m.start_at || "clips", (v) => commit((tl) => { tl.music.start_at = v; if (tl.beats?.length) tl.beats = beatsFromSong(tl); }))) : null,
    i === 0 ? beatsSection(m) : null,
    el("div", { class: "btns" }, el("button", { class: "danger", onclick: deleteSelection }, n > 1 ? "Remove this piece" : "Remove music")),
    el("div", { class: "hint" }, "Select the music, put the playhead where you want the cut, press ✂ Split. Each piece has its own song, end and fade-out. Tip: click a song in the media bin to switch the selected piece."));
}

function projectInspector() {
  const tl = S.tl, st = tl.style || {};
  const updS = (key) => (fn) => commit((t) => { t.style = t.style || {}; fn(t.style); }, key ? "style:" + key : null);
  const aspect = Object.entries(ASPECTS).find(([, [w, h]]) => w === tl.format?.width && h === tl.format?.height)?.[0] || "9:16";
  const plat = PLATFORMS.find((p) => p.size[0] === tl.format?.width && p.size[1] === tl.format?.height);
  const { total } = lay();
  return el("div", { class: "insp" },
    el("h3", {}, "Video settings"),
    el("div", { class: "sub" }, `${tl.clips.length} clips · ${fmt(total)} · click a clip to edit it`),
    field("Title", el("input", { value: tl.title || "", onchange: (e) => commit((t) => { t.title = e.target.value; }) })),
    field("Where is it going?", chips(PLATFORMS.map((p) => p.name), plat?.name, (v) => commit((t) => { const [w, h] = PLATFORMS.find((p) => p.name === v).size; t.format = { ...(t.format || {}), width: w, height: h }; }))),
    el("div", { class: "hint" }, plat ? `${plat.size[0]} × ${plat.size[1]} (${aspect}). ${plat.note}` : `${tl.format?.width} × ${tl.format?.height}. Custom size, tap a button above to switch.`),
    el("div", { class: "sec" }, el("div", { class: "sec-t" }, "Style"),
      field("Color look", chips(GRADES, st.grade || "warm", (v) => updS()((s) => { s.grade = v; }))),
      field("Font", chips(FONTS, st.font || "Heebo", (v) => updS()((s) => { s.font = v; }))),
      el("div", { class: "row" },
        field("Accent color", el("input", { type: "color", value: st.accent || "#FFD400", oninput: (e) => updS("acc")((s) => { s.accent = e.target.value; }) })),
        field("Vignette", el("input", { type: "checkbox", checked: st.vignette !== false, onchange: (e) => updS()((s) => { s.vignette = e.target.checked; }) }))),
      field("Beat pulse", range(st.beat_pulse ?? 0, 0, 0.1, 0.005, (v) => updS("bp")((s) => { s.beat_pulse = v; })), (st.beat_pulse ?? 0).toFixed(3))),
    el("div", { class: "sec" }, el("div", { class: "sec-t" }, "Brand opener"),
      el("label", {}, el("input", { type: "checkbox", checked: !!tl.opener, onchange: (e) => commit((t) => {
        t.opener = e.target.checked ? { src: "brand/brand-opener.mp4", seconds: 4, fit: (t.format?.height ?? 1920) > (t.format?.width ?? 1080) ? "cover" : "contain" } : null;
      }) }), " Play the opener first")),
    el("div", { class: "sec" }, el("div", { class: "sec-t" }, "Keys"),
      el("div", { class: "hint" }, "Space play/pause · S split · ⌫ delete · ⌘Z undo · ⇧⌘Z redo · ← → frame (⇧ = 1s) · Esc deselect")));
}

// ---------------------------------------------------------------------------
// Render (preview / final MP4)
// ---------------------------------------------------------------------------
async function startRender(preview) {
  if (S.dirty) await save();
  try { S.render = await api("/render", { method: "POST", body: JSON.stringify({ preview }) }); pollRender(); }
  catch (e) { toast(e.message); }
}
async function pollRender() {
  try { S.render = await api("/render"); } catch { return; }
  renderRender();
  if (S.render.running) setTimeout(pollRender, 1000);
  else if (S.render.ok) toast(S.render.preview ? "Preview ready" : "MP4 exported 🎉");
}
async function downloadStill() {
  if (S.dirty) await save();
  try {
    const opener = S.tl.opener ? S.tl.opener.seconds : 0;
    const r = await fetch(`${API}/still`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t: Math.max(0, S.time - opener) }) });
    if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.detail || r.statusText); }
    const a = el("a", { href: URL.createObjectURL(await r.blob()), download: `${S.tl.title || ID} ${S.time.toFixed(1)}s.png` });
    document.body.append(a); a.click(); a.remove();
    toast("Image downloaded 📷");
  } catch (e) { toast(`Image failed: ${e.message}`); }
}
async function quickDownload() {
  if (S.dirty) await save();
  const box = $("#renderStatus"), btn = $("#dlBtn");
  btn.disabled = true;
  try {
    const ids = S.multi.length ? [...S.multi] : (S.sel && S.sel.t === "clip" ? [S.sel.id] : []);
    let j = await api("/quick-export", { method: "POST", body: JSON.stringify({ clips: ids }) });
    while (j.running) {
      box.replaceChildren(el("span", {}, `Preparing ${ids.length ? "selected" : "full"} download ${Math.round((j.progress || 0) * 100)}%`), el("div", { class: "bar" }, el("i", { style: { width: `${(j.progress || 0) * 100}%` } })));
      await new Promise((r) => setTimeout(r, 800));
      j = await api("/quick-export");
    }
    if (!j.ok) throw new Error(j.error || "failed");
    box.replaceChildren();
    const a = el("a", { href: `/api/editor/${encodeURIComponent(ID)}/quick-export/file` });
    document.body.append(a); a.click(); a.remove();
    toast(ids.length ? `Downloaded the ${ids.length} selected clip${ids.length > 1 ? "s" : ""}` : j.left_out?.length ? `Downloaded. Not included: ${j.left_out.join(", ")}` : "Downloaded 🎉");
  } catch (e) { box.replaceChildren(); toast(`Download failed: ${e.message}`); }
  btn.disabled = false;
}
function renderRender() {
  const r = S.render, box = $("#renderStatus");
  $("#previewBtn").disabled = $("#exportBtn").disabled = !!r?.running;
  if (!r || (!r.running && r.ok == null)) { box.replaceChildren(); return; }
  if (r.running) box.replaceChildren(el("span", {}, `${r.preview ? "Preview" : "Export"} ${Math.round((r.progress || 0) * 100)}%`), el("div", { class: "bar" }, el("i", { style: { width: `${(r.progress || 0) * 100}%` } })));
  else if (r.ok) box.replaceChildren(el("a", { href: `/media/${encodeURIComponent(ID)}/${r.output}`, target: "_blank" }, `▶ Open ${r.preview ? "preview" : "MP4"}`));
  else box.replaceChildren(el("span", { style: { color: "var(--danger)" }, title: r.log || "" }, "Render failed (hover for log)"));
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
let lastSelKey = "";
// Media bin and settings panel: open only when needed. The comments panel takes the settings slot while it is open.
function layoutPanels() {
  const snd = !!S.panels.snd && !S.cm.open, insp = S.panels.insp && !S.cm.open && !snd;
  $("#bin").classList.toggle("hidden", !S.panels.bin);
  $("#inspector").classList.toggle("hidden", !insp);
  $("#sound").classList.toggle("hidden", !snd);
  S.sndW = Math.max(420, Math.min(640, innerWidth - (S.panels.bin ? S.binW : 0) - (S.chat.open ? 400 : 0) - 380));
  $("#main").style.gridTemplateColumns = [S.panels.bin ? `${S.binW}px` : null, "1fr", snd ? `${S.sndW}px` : insp || S.cm.open ? "310px" : null].filter(Boolean).join(" ");
  $("#sndBtn").classList.toggle("on", snd);
  $("#binGrip").classList.toggle("hidden", !S.panels.bin); $("#binGrip").style.left = `${S.binW - 3}px`;
  $("#binBtn").classList.toggle("on", S.panels.bin);
  $("#inspBtn").classList.toggle("on", S.panels.insp);
}
function setPanel(k, on) {
  S.panels[k] = on;
  try { localStorage.setItem("montage-panel-" + k, on ? "1" : "0"); } catch { /* storage blocked */ }
  layoutPanels(); if (k === "insp" && on) renderInspector(true);
}
function renderAll() {
  if (!S.tl) return;
  const selKey = JSON.stringify(S.sel);
  if (selKey !== lastSelKey) { lastSelKey = selKey; document.activeElement?.blur?.(); }
  $("#title").textContent = S.tl.title || ID;
  const [w, h] = [S.tl.format?.width ?? 1080, S.tl.format?.height ?? 1920];
  $("#player").style.aspectRatio = `${w}/${h}`;
  layoutPanels(); renderTimeline(); renderTrackHeads(); renderInspector(); renderSound(); renderSave(); renderBin(); renderComments(); renderChat(); renderRulers(); renderXform();
}

// ---------------------------------------------------------------------------
// Review notes: pinned to the timeline, worked through as a checklist.
// open -> (Claude fixes and replies) -> review -> (you approve) -> resolved
// Kept out of undo/redo on purpose, so undoing an edit never un-writes a note.
// ---------------------------------------------------------------------------
function keepComments(cm) { if (cm && cm.length) S.tl.comments = cm; else delete S.tl.comments; }
const cmList = () => S.tl.comments || [];
const cmStamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
function cmTime(c) {
  if (c.clip) { const it = lay().items.find((x) => x.clip.id === c.clip); if (it) return it.start + (c.offset || 0); }
  if (c.group) { const it = lay().items.find((x) => x.clip.group === c.group); if (it) return it.start; }   // clip was removed: stay with its group
  return c.at ?? 0;
}
function cmState(c) {
  if (c.status === "resolved") return "resolved";
  if (c.status === "review") return "review";
  const last = (c.replies || [])[(c.replies || []).length - 1];
  return !last ? "new" : last.by === "claude" ? "waiting" : "todo";
}
function cmClipLabel(c) {
  const k = c.clip && findClip(c.clip), g = (k?.group || c.group) && groupOf(k?.group || c.group);
  return [k ? (k.label || k.id) : (c.clip ? "(clip removed)" : ""), g ? g.name : ""].filter(Boolean).join(" · ");
}
function cmSync(l) { for (const c of l) { const k = c.clip && findClip(c.clip); if (k) { if (k.group) c.group = k.group; else delete c.group; } } }
function cmChange(fn) {
  const before = new Map((S.tl.comments || []).map((c) => [c.id, JSON.stringify(c)]));
  fn(S.tl.comments = S.tl.comments || []); cmSync(S.tl.comments);
  for (const c of S.tl.comments) if (before.get(c.id) !== JSON.stringify(c)) c.updated = new Date().toISOString(); if (!S.tl.comments.length) delete S.tl.comments; S.dirty = true; scheduleSave(); renderTimeline(); renderComments(); }
function cmOpen(on) {
  S.cm.open = on; $("#comments").classList.toggle("hidden", !on); layoutPanels(); $("#cmtBtn").classList.toggle("on", on);
  renderComments();
  if (on) setTimeout(() => $("#cmText")?.focus(), 0);
}
function cmAdd(text) {
  text = text.trim(); if (!text) return;
  const t = S.cm.pinAt ?? S.time; S.cm.pinAt = null;      // spoken notes are pinned where you pressed the mic
  const it = lay().items.find((x) => t >= x.start && t < x.start + x.duration);
  const c = { id: "n" + Math.random().toString(36).slice(2, 7), text, status: "open", created: cmStamp(), replies: [] };
  if (it) { c.clip = it.clip.id; c.offset = r3(t - it.start); if (it.clip.group) c.group = it.clip.group; } else c.at = r3(t);
  S.cm.draft = ""; S.cm.tab = "todo"; S.cm.flash = c.id;
  cmChange((l) => l.push(c));
}
function cmGo(c) { S.cm.flash = c.id; seek(cmTime(c)); renderComments(); const sc = $("#tlScroll"), x = cmTime(c) * S.pps; if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - 120; }
const CM_TAB = { new: "todo", todo: "todo", waiting: "wait", review: "wait", resolved: "resolved" };
const CM_LABEL = { new: "new", todo: "to do", waiting: "needs your reply", review: "fixed - approve?", resolved: "resolved" };
function cmFlags() {
  if (!S.tl) return [];
  const lanes = [-1e9, -1e9], out = [];
  for (const c of cmList().filter((x) => x.status !== "resolved").sort((a, b) => cmTime(a) - cmTime(b))) {
    const st = cmState(c), x = cmTime(c) * S.pps, w = Math.min(190, 14 + c.text.length * 6.5);
    let lane = lanes[0] <= x ? 0 : lanes[1] <= x ? 1 : (lanes[0] <= lanes[1] ? 0 : 1);
    lanes[lane] = x + w + 4;
    out.push(el("div", { class: `nflag ${st}` + (S.cm.flash === c.id && S.cm.open ? " sel" : ""), style: { left: x + "px", top: 3 + lane * 20 + "px" },
      title: `${CM_LABEL[st]} - ${c.text}`, onpointerdown: (e) => { e.stopPropagation(); S.cm.tab = CM_TAB[st]; cmOpen(true); cmGo(c); } }, c.text.replace(/\s+/g, " ")));
  }
  return out;
}
function cmCard(c) {
  const state = cmState(c), st = CM_LABEL[state];
  const upd = (fn) => cmChange(() => fn(c));
  const reply = el("input", { placeholder: "Reply...", onkeydown: (e) => {
    if (e.key !== "Enter" || !e.target.value.trim()) return;
    const v = e.target.value.trim(); upd(() => { (c.replies = c.replies || []).push({ by: "user", text: v, ts: cmStamp() }); if (c.status !== "open") { c.status = "open"; delete c.resolved_at; } });
  } });
  const acts = c.status === "review"
    ? [el("button", { class: "primary", onclick: () => upd(() => { c.status = "resolved"; c.resolved_at = cmStamp(); }) }, "✓ Approve"),
       el("button", { onclick: () => upd(() => { c.status = "open"; }) }, "Not yet")]
    : c.status === "open"
    ? [el("button", { onclick: () => upd(() => { c.status = "resolved"; c.resolved_at = cmStamp(); }) }, "✓ Done")]
    : [el("button", { onclick: () => upd(() => { c.status = "open"; delete c.resolved_at; }) }, "Reopen")];
  acts.push(el("button", { class: "danger", onclick: () => cmChange((l) => l.splice(l.indexOf(c), 1)) }, "Delete"));
  return el("div", { class: `cm-card ${state}` + (S.cm.flash === c.id ? " flash" : ""), id: "cm-" + c.id },
    el("div", { class: "cm-top" }, el("span", { class: "t", title: "Jump to it", onclick: () => cmGo(c) }, fmt(cmTime(c))), el("span", {}, cmClipLabel(c)), el("span", { class: "st" }, st)),
    el("div", { class: "cm-text" }, c.text),
    ...(c.replies || []).map((r) => el("div", { class: "cm-reply " + r.by }, el("b", {}, r.by === "claude" ? "Claude" : "You"), r.text)),
    el("div", { class: "cm-actions" }, ...acts, reply));
}
function renderComments() {
  const box = $("#comments"); if (!S.tl) return;
  const n = cmList().filter((c) => c.status !== "resolved").length;
  const w = cmList().filter((c) => CM_TAB[cmState(c)] === "wait").length;
  $("#cmtBtn").textContent = n ? `💬 Notes (${n})` + (w ? ` · ${w} for you` : "") : "💬 Notes";
  if (!S.cm.open) return;
  const all = cmList(), by = (k) => all.filter((c) => CM_TAB[cmState(c)] === k).sort((a, b) => cmTime(a) - cmTime(b));
  const tabs = [["todo", "To do"], ["wait", "Waiting for you"], ["resolved", "Resolved"]];
  const pinT = S.cm.pinAt ?? S.time, it = lay().items.find((x) => pinT >= x.start && pinT < x.start + x.duration);
  const ta = el("textarea", { id: "cmText", placeholder: "What should change here?  (⌘/Ctrl+Enter to add)", dir: "auto",
    oninput: (e) => { S.cm.draft = e.target.value; if (!S.cm.draft.trim()) S.cm.pinAt = null; }, onkeydown: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); cmAdd(ta.value); } } });
  ta.value = S.cm.draft;
  const list = by(S.cm.tab);
  box.replaceChildren(
    el("div", { class: "cm-head" }, el("h3", {}, "Review notes"), el("button", { class: "ghost", onclick: () => cmOpen(false) }, "✕")),
    el("div", { class: "cm-legend" }, ...[["new", "new"], ["todo", "you replied"], ["waiting", "Claude replied"], ["review", "fixed, approve?"], ["resolved", "resolved"]].map(([k, l]) => el("span", {}, el("i", { style: { background: `var(--st-${k})` } }), l))),
    el("div", { class: "cm-compose" }, el("div", { class: "where" }, `Pinned at ${fmt(pinT)}` + (it ? ` on ${it.clip.label || it.clip.id}` : "")), ta,
      el("div", { class: "mic-stat hidden", "data-kind": "note" }),
      el("div", { class: "row" }, micControl("note"), el("button", { class: "primary", onclick: () => cmAdd(ta.value) }, "Add note"))),
    el("div", { class: "cm-tabs" }, ...tabs.map(([k, l]) => el("button", { class: (S.cm.tab === k ? "on " : "") + (k === "wait" && by(k).length ? "alert" : ""), onclick: () => { S.cm.tab = k; renderComments(); } }, l, el("span", { class: "dot" }, String(by(k).length))))),
    ...(list.length ? list.map(cmCard) : [el("div", { class: "cm-empty" }, S.cm.tab === "todo" ? "Nothing for Claude to do. Add notes as you watch." : S.cm.tab === "wait" ? "Nothing is waiting for you." : "No resolved notes.")]),
    ...(S.cm.tab === "resolved" && list.length ? [el("button", { class: "danger", onclick: () => cmChange((l) => { for (let i = l.length - 1; i >= 0; i--) if (l[i].status === "resolved") l.splice(i, 1); }) }, "Clear resolved")] : []));
  if (S.cm.flash) document.getElementById("cm-" + S.cm.flash)?.scrollIntoView({ block: "nearest" });
}

// ---------------------------------------------------------------------------
// AI chat: ask for a change on the selected clips, see it live, approve or reject.
// The proposal only lives in the preview player (S.chat.pending). Approve saves a version, then applies it.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function chatContext() {
  const ids = S.multi.length ? [...S.multi] : (S.sel?.t === "clip" ? [S.sel.id] : []);
  return ids.filter(findClip);
}
function initChat() {
  $("#chat").replaceChildren(
    el("div", { class: "ch-head" }, el("h3", {}, "✨ AI editor"),
      el("button", { class: "ghost", title: "Clear the conversation", onclick: () => { if (S.chat.busy || S.chat.pending) return; S.chat.msgs = []; renderChat(); } }, "Clear")),
    el("div", { class: "ch-ctx", id: "chCtx" }),
    el("div", { class: "ch-list", id: "chList" }),
    el("div", { class: "ch-pend hidden", id: "chPend" }),
    el("div", { class: "ch-compose" },
      el("label", { class: "ch-board hidden", id: "chBoardRow", title: "Let the AI look at the pictures and videos on your inspiration board for every request. The written rules are always used." }, el("input", { type: "checkbox", id: "chBoard" }), el("span", { id: "chBoardTxt" })),
      el("textarea", { id: "chatInput", rows: "3", placeholder: "Ask for a change, for example: add more contrast",
        onpaste: (e) => { const f = [...(e.clipboardData?.files || [])].filter((x) => /^(image|video)\//.test(x.type)); if (f.length) { e.preventDefault(); chatAttach(f); } },
        onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); chatSend(); } } }),   // Enter sends, Shift+Enter makes a new line
      el("div", { class: "ch-attach", id: "chAttach" }),
      el("div", { class: "mic-stat hidden", "data-kind": "chat" }),
      el("div", { class: "ch-row" }, el("span", { class: "hint", id: "chHint" }),
        el("button", { class: "ghost", title: "Attach a photo or video. It is saved in this project's media folder (uploads).", onclick: () => $("#chFile").click() }, "📎"),
        el("input", { type: "file", id: "chFile", accept: "image/*,video/*", multiple: true, class: "hidden", onchange: (e) => { chatAttach([...e.target.files]); e.target.value = ""; } }),
        micControl("chat"), el("button", { class: "primary", id: "chSend", onclick: chatSend }, "Send"))));
}
function setChatOpen(on) {
  S.chat.open = on;
  try { localStorage.setItem("montage-chat-open", on ? "1" : "0"); } catch { /* storage blocked */ }
  renderChat();
}
function renderChat() {
  const box = $("#chat");
  box.classList.toggle("hidden", !S.chat.open);
  document.body.classList.toggle("chat-open", S.chat.open);
  $("#aiBtn").classList.toggle("on", S.chat.open);
  if (!S.chat.open || !S.tl || !$("#chCtx")) return;
  const ids = chatContext(), nb = S.board.items.filter((i) => i.use !== false).length, nr = rulesActive().length, nd = rulesDraft().length;
  $("#chCtx").replaceChildren(ids.length
    ? el("span", {}, `Changes apply to ${ids.length} clip${ids.length > 1 ? "s" : ""}: `, ...ids.map((id) => el("span", { class: "chip" }, `#${clipIndex(id) + 1} ${findClip(id).label || ""}`.trim())),
        el("span", { class: "clr", onclick: () => { S.multi = [], S.multiX = []; S.sel = null; renderAll(); } }, "clear"))
    : el("span", {}, "Whole video. Click a clip on the timeline to aim the change at it. ⌘/Ctrl-click or Shift-click to pick several."),
    nr ? el("div", { class: "ch-rules" }, `✦ ${nr} rule${nr > 1 ? "s" : ""} from your board ${nr > 1 ? "are" : "is"} used. `, el("span", { class: "clr", onclick: () => { S.board.view = "rules"; S.binTab = BOARD_TAB; setPanel("bin", true); renderBin(); } }, "manage")) : "");
  const list = $("#chList");
  const nodes = S.chat.msgs.map((m, i) => {
    return el("div", { class: `ch-msg ${m.role}${m.error ? " err" : ""}` },
      m.role === "user" && (m.ids?.length || m.board) ? el("span", { class: "on" }, [m.ids?.length ? `on ${m.ids.map((id) => "#" + (clipIndex(id) + 1)).join(", ")}` : "", m.board ? "✦ looked at the board" : ""].filter(Boolean).join(" · ")) : null,
      m.text,
      m.lines?.length ? el("ul", {}, ...m.lines.map((l) => el("li", {}, l))) : null,
      m.status ? el("div", { class: `st ${m.status}` }, { approved: "✓ Approved and saved", approved_edited: "✓ Approved with your edits, saved", rejected: "✕ Rejected, nothing changed", discarded: "Dropped (the file changed elsewhere)", refined: "Tweaked below" }[m.status] || m.status) : null);
  });
  if (S.chat.busy) nodes.push(el("div", { class: "ch-think" }, "Thinking… this can take up to a minute ",
    el("button", { class: "ghost", title: "Stop waiting for this answer", onclick: () => { S.chat.token = (S.chat.token || 0) + 1; S.chat.busy = false; S.chat.msgs.push({ role: "ai", text: "Cancelled.", error: true }); renderChat(); } }, "Cancel")));
  if (!S.chat.msgs.length && !S.chat.busy) nodes.push(el("div", { class: "hint" }, "Pick one or more clips, then ask for a change. You will see it live in the preview. Approve keeps it (a version is saved first), Reject throws it away."));
  list.replaceChildren(...nodes);
  list.scrollTop = list.scrollHeight;
  const pend = S.chat.pending, bar = $("#chPend");
  bar.classList.toggle("hidden", !pend);
  if (pend) bar.replaceChildren(
    el("div", { class: "pt" }, "The change is on screen and not saved yet. Edit it by hand on the timeline or the panel, or ask for a tweak below."),
    el("div", { class: "ch-actions" },
      el("button", { class: "ok", onclick: chatApprove }, "✓ Approve"),
      el("button", { onclick: chatCompare, title: "Switch the preview between before and after" }, S.chat.showBefore ? "Show after" : "Show before"),
      el("button", { class: "no", onclick: () => chatReject(false) }, "✕ Reject")));
  $("#boardBtn").textContent = nd ? `✦ Inspiration (${nd} new)` : "✦ Inspiration";
  $("#chBoardRow").classList.toggle("hidden", !nb);
  $("#chBoardTxt").textContent = `✦ Look at my inspiration board (${nb})`;
  $("#chatInput").disabled = S.chat.busy; $("#chSend").disabled = S.chat.busy;
  $("#chatInput").placeholder = pend ? "Ask for a tweak to this change, for example: a bit less" : "Ask for a change, for example: add more contrast";
  $("#chHint").textContent = "↵ send · ⇧↵ new line";
  renderSave();
}
async function dropToBin(files) {
  const special = [BANK_TAB, MOTION_TAB].includes(S.binTab);
  const folder = special || S.binTab === "all" ? "uploads" : S.binTab === LOOSE ? "" : S.binTab;
  const okExt = /\.(mp4|mov|m4v|webm|mkv|avi|jpe?g|png|webp|gif|heic|mp3|wav|m4a|aac|ogg|flac)$/i;
  const list = files.filter((f) => okExt.test(f.name));
  if (!list.length) { toast("Drop photos, videos or sounds"); return; }
  let done = 0, added = [];
  for (const f of list) {
    toast(`Adding ${done + 1} of ${list.length}: ${f.name}`);
    try {
      const r = await fetch(`${API}/upload?name=${encodeURIComponent(f.name)}&folder=${encodeURIComponent(folder)}`, { method: "POST", body: f });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof b.detail === "string" ? b.detail : r.statusText);
      added.push(b.name);
    } catch (e) { toast(`Could not add ${f.name}: ${e.message}`); }
    done++;
  }
  await loadMedia().catch(() => {});
  if (added.length) { if (special) S.binTab = "all"; renderBin(); toast(`Added ${added.length} file${added.length > 1 ? "s" : ""} to ${folder ? folderLabel(folder) : "the media folder"}`); }
}
async function chatAttach(files) {
  S.chat.attach = S.chat.attach || [];
  for (const f of files) {
    try {
      const r = await fetch(`${API}/upload?name=${encodeURIComponent(f.name || "pasted.png")}`, { method: "POST", body: f });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof b.detail === "string" ? b.detail : r.statusText);
      S.chat.attach.push({ src: b.src, name: b.name });
    } catch (e) { toast(`Could not attach ${f.name}: ${e.message}`); }
  }
  renderAttach(); loadMedia().catch(() => {});
}
function renderAttach() {
  const box = $("#chAttach"); if (!box) return;
  box.replaceChildren(...(S.chat.attach || []).map((a, i) => el("span", { class: "ch-chip", title: a.src }, `📎 ${a.name}`,
    el("button", { class: "ghost", onclick: () => { S.chat.attach.splice(i, 1); renderAttach(); } }, "✕"))));
}
async function chatSend() {
  const ta = $("#chatInput"), text = ta.value.trim();
  if (!text || S.chat.busy || !S.tl) return;
  const ids = chatContext();
  const history = S.chat.msgs.filter((m) => m.text && !m.error).map((m) => ({ role: m.role === "ai" ? "assistant" : "user", text: m.text }));
  const useBoard = S.board.items.some((i) => i.use !== false) && (!!$("#chBoard")?.checked || /inspir|referenc|board|השראה|רפרנס|לוח/i.test(text));   // asking for inspiration is enough, no need to tick the box
  const att = S.chat.attach || [];
  S.chat.attach = []; renderAttach();
  const sent = att.length ? `${text}\n[Attached by the user, already in the media bin: ${att.map((a) => a.src).join(", ")}]` : text;
  S.chat.msgs.push({ role: "user", text: att.length ? `${text}  📎 ${att.map((a) => a.name).join(", ")}` : text, ids, board: useBoard });
  ta.value = ""; S.chat.busy = true; const token = (S.chat.token = (S.chat.token || 0) + 1);
  try {
    renderChat();
    // While a change is under review the request is about the edited change (S.tl already holds it), so tweaks stack on top.
    const started = await api("/chat", { method: "POST", body: JSON.stringify({ message: sent, clip_ids: ids, timeline: S.tl, history, use_board: useBoard }) });
    let job;
    for (let n = 0; n < 400; n++) {
      await sleep(1200);
      job = await api("/chat");
      if (job.id === started.id && !job.running) break;
    }
    if (token !== S.chat.token) return;          // you pressed Cancel: ignore the late answer
    if (!job || job.running) throw new Error("The assistant did not answer in time");
    if (!job.ok) throw new Error(job.error || "The assistant failed");
    const r = job.result;
    if (!r.timeline) S.chat.msgs.push({ role: "ai", text: r.reply });
    else {
      const lv = lockViolation(S.chat.pending ? S.chat.pending.before : S.tl, r.timeline);
      if (lv) S.chat.msgs.push({ role: "ai", text: `Not applied: "${lv}" is locked. Release its lock first.`, error: true });
      else { S.chat.msgs.push({ role: "ai", text: r.reply, lines: r.lines, status: null }); showProposal(r, S.chat.msgs.length - 1, text); }
    }
  } catch (e) {
    S.chat.msgs.push({ role: "ai", text: e.message, error: true });
  } finally {
    if (token === S.chat.token) S.chat.busy = false;
    try { renderChat(); } catch (e) { console.error(e); }
  }
}
// The proposal becomes the working timeline, so every normal editing tool changes it. Nothing is saved until Approve.
function showProposal(r, msgIndex, request) {
  const prev = S.chat.pending;
  if (prev) {                                  // a tweak on top of a change that is still under review
    S.chat.msgs[prev.msg].status = "refined";
    S.undo.push(clone(S.tl));
    prev.proposal = r.timeline; prev.msg = msgIndex; prev.ids = [...new Set([...prev.ids, ...(r.clip_ids || [])])];
  } else {
    S.chat.pending = { before: clone(S.tl), proposal: r.timeline, undoBase: S.undo.slice(), redoBase: S.redo.slice(), wasDirty: S.dirty, ids: r.clip_ids || [], msg: msgIndex, request };
  }
  S.chat.showBefore = false;
  S.tl = clone(r.timeline);
  changed({ save: false });
  const first = (r.clip_ids || [])[0];
  if (first) { const it = lay().items.find((x) => x.clip.id === first); if (it) seek(it.start + 0.05); }
  if (S.tl.clips.some((c) => c.bgfx && c.bgfx.status !== "done")) previewPendingBgFx();
}
function chatCompare() {
  const p = S.chat.pending; if (!p) return;
  S.chat.showBefore = !S.chat.showBefore;
  player?.update(clone(S.chat.showBefore ? p.before : S.tl));
  renderChat();
}
function chatReject(auto = false) {
  const p = S.chat.pending; if (!p) return;
  S.chat.pending = null;
  S.chat.msgs[p.msg].status = auto ? "discarded" : "rejected";
  S.tl = clone(p.before); S.undo = p.undoBase; S.redo = p.redoBase; S.dirty = p.wasDirty; S.lastKey = null; S.chat.showBefore = false;
  changed({ save: false }); renderChat();
}
async function chatApprove() {
  const p = S.chat.pending; if (!p || S.chat.busy) return;
  if (bgBusy) { toast("The background preview is still being made. Approve when it is ready."); return; }
  try { await versionSnapshot("Before: " + p.request, "auto", p.before); }
  catch (e) { toast("Could not save a version first, so nothing was changed: " + e.message); return; }
  const edited = JSON.stringify(S.tl) !== JSON.stringify(p.proposal);
  S.chat.pending = null;
  S.chat.msgs[p.msg].status = edited ? "approved_edited" : "approved";
  S.undo = [...p.undoBase, clone(p.before)]; S.redo = []; S.lastKey = null; S.chat.showBefore = false;
  changed();                                   // now it is saved like any other edit
  versionSnapshot("AI: " + p.request + (edited ? " (edited)" : ""), "ai").catch(() => {});
  renderChat(); toast("Change approved. ⌘Z undoes it, or open Versions to go back.");
  if (S.tl.clips.some((c) => c.bgfx && c.bgfx.status !== "done")) { if (S.dirty) await save().catch(() => {}); runPendingBgFx(); }
}

// ---------------------------------------------------------------------------
// Versions: named snapshots on disk (projects/<id>/artifacts/versions/)
// ---------------------------------------------------------------------------
async function versionSnapshot(label, source = "manual", tl = S.tl) {
  const v = await api("/versions", { method: "POST", body: JSON.stringify({ label, source, timeline: tl }) });
  loadVersions();
  return v;
}
async function loadVersions() {
  try { S.ver.list = (await api("/versions")).versions; } catch { /* offline */ }
  $("#verBtn").textContent = `🕘 Versions${S.ver.list.length ? ` (${S.ver.list.length})` : ""}`;
  if (S.ver.open) renderVersions();
}
const SOURCE_LABEL = { manual: "saved by you", auto: "automatic", ai: "after AI change" };
function renderVersions() {
  const box = $("#versions");
  box.classList.toggle("hidden", !S.ver.open);
  $("#verBtn").classList.toggle("on", S.ver.open);
  if (!S.ver.open) return;
  const when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  box.replaceChildren(
    el("div", { class: "vr-head" }, el("b", {}, "Versions"), el("button", { class: "ghost", onclick: () => { S.ver.open = false; renderVersions(); } }, "✕")),
    el("div", { class: "vr-save" },
      el("input", { id: "verName", placeholder: "Name this version (optional)", onkeydown: (e) => { if (e.key === "Enter") saveVersionClick(); } }),
      el("button", { class: "primary", onclick: saveVersionClick }, "Save version")),
    el("div", { class: "vr-list" }, ...(S.ver.list.length
      ? S.ver.list.map((v) => el("div", { class: "vr-item" },
          el("div", { class: "vr-main" }, el("div", { class: "vr-label", title: v.label }, v.label), el("div", { class: "vr-meta" }, `${v.id} · ${when(v.created)} · ${v.clips} clips · ${SOURCE_LABEL[v.source] || v.source}`)),
          el("button", { onclick: () => restoreVersion(v) }, "Restore")))
      : [el("div", { class: "hint" }, "No versions yet. Save one before a big change. Every approved AI change saves one automatically.")])));
}
async function saveVersionClick() {
  const inp = $("#verName"), label = inp?.value.trim() || `Version ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  try { await versionSnapshot(label, "manual"); toast("Version saved"); if (inp) inp.value = ""; } catch (e) { toast("Not saved: " + e.message); }
}
async function restoreVersion(v) {
  if (!confirm(`Go back to "${v.label}" (${v.id})?\n\nYour current state is saved as a new version first, so you can return to it.`)) return;
  try {
    const full = await api("/versions/" + v.id);
    if (S.chat.pending) chatReject(true);
    await versionSnapshot(`Before restoring ${v.id}`, "auto");
    const cm = S.tl.comments;
    commit((tl) => { for (const k of Object.keys(tl)) delete tl[k]; Object.assign(tl, clone(full.timeline)); });
    keepComments(cm); changed();
    toast(`Restored ${v.id}`);
  } catch (e) { toast("Could not restore: " + e.message); }
}
async function autoSnapshotOnOpen() {
  await loadVersions();
  const latest = S.ver.list[0];
  if (!latest || Number(S.mtime) / 1e6 > Date.parse(latest.created) + 1000) await versionSnapshot("Opened the editor", "auto").catch(() => {});
}

// ---------------------------------------------------------------------------
// Voice input: record, transcribe on this Mac, drop the text into the box (you read it, then send).
// One recording at a time. The state lives here, not in the buttons, because the notes panel redraws itself.
// ---------------------------------------------------------------------------
const MIC = { rec: null, stream: null, chunks: [], kind: null, t0: 0, tBusy: 0, tick: null, busy: false, warmDone: false, lang: "" };
try { MIC.lang = localStorage.getItem("montage-mic-lang") || ""; } catch { /* storage blocked */ }
function micControl(kind) {
  const btn = el("button", { class: "mic", "data-kind": kind, title: "Speak instead of typing. Click to start, click again to stop.", onclick: () => micToggle(kind) }, "🎙");
  const sel = el("select", { class: "mic-lang", title: "Language you speak", onchange: (e) => {
    MIC.lang = e.target.value; try { localStorage.setItem("montage-mic-lang", MIC.lang); } catch { /* storage blocked */ }
    document.querySelectorAll(".mic-lang").forEach((x) => { x.value = MIC.lang; });
  } }, ...[["", "Auto"], ["he", "עברית"], ["en", "English"]].map(([v, t]) => el("option", { value: v }, t)));
  sel.value = MIC.lang;
  const wrap = el("span", { class: "mic-wrap" }, btn, sel);
  micPaint(btn);
  return wrap;
}
function micPaint(btn) {
  const mine = MIC.kind === btn.dataset.kind;
  btn.classList.toggle("rec", !!MIC.rec && mine);
  btn.disabled = MIC.busy || (!!MIC.rec && !mine);
  btn.textContent = MIC.busy && mine ? "⏳" : MIC.rec && mine ? `⏹ ${fmt((Date.now() - MIC.t0) / 1000).replace(/\.\d$/, "")}` : "🎙";
}
// While the speech is being turned into text: a moving bar and a seconds counter, so it never looks stuck.
function micStatPaint(box) {
  const mine = MIC.kind === box.dataset.kind;
  const show = mine && (MIC.busy || MIC.rec);
  box.classList.toggle("hidden", !show);
  if (!show) { box.replaceChildren(); return; }
  if (MIC.rec) {
    box.className = "mic-stat rec";
    box.replaceChildren(el("span", { class: "ms-txt" }, `● Recording ${fmt((Date.now() - MIC.t0) / 1000).replace(/\.\d$/, "")} · click ⏹ when you are done`));
    return;
  }
  const secs = Math.floor((Date.now() - MIC.tBusy) / 1000);
  const slow = !MIC.warmDone && secs > 6 ? " · loading the speech model the first time" : "";
  box.className = "mic-stat busy";
  box.replaceChildren(el("span", { class: "ms-txt" }, `Turning your voice into text… ${secs}s${slow}`), el("div", { class: "ms-bar" }, el("i", {})));
}
const micRepaint = () => { document.querySelectorAll(".mic").forEach(micPaint); document.querySelectorAll(".mic-stat").forEach(micStatPaint); };
async function micToggle(kind) {
  if (MIC.busy) return;
  if (MIC.rec) { if (MIC.kind === kind) MIC.rec.stop(); return; }
  try {
    MIC.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) { toast("The microphone is blocked. Allow it for this page (the lock icon in the address bar)."); return; }
  fetch("/api/editor/stt/warm", { method: "POST" }).catch(() => {});      // load the speech model while you talk
  MIC.chunks = []; MIC.kind = kind; MIC.t0 = Date.now();
  if (kind === "note") S.cm.pinAt = S.time;                                // the note belongs to the moment you started talking
  const rec = new MediaRecorder(MIC.stream);
  rec.ondataavailable = (e) => { if (e.data.size) MIC.chunks.push(e.data); };
  rec.onstop = micDone;
  MIC.rec = rec; rec.start();
  MIC.tick = setInterval(micRepaint, 500); micRepaint();
}
async function micDone() {
  clearInterval(MIC.tick); MIC.stream?.getTracks().forEach((t) => t.stop());
  const kind = MIC.kind, blob = new Blob(MIC.chunks, { type: MIC.rec.mimeType || "audio/webm" });
  MIC.rec = null; MIC.busy = true; MIC.tBusy = Date.now(); MIC.tick = setInterval(micRepaint, 500); micRepaint();
  try {
    if (Date.now() - MIC.t0 < 600) throw new Error("That was too short, try again");
    const r = await fetch(`/api/editor/transcribe?lang=${encodeURIComponent(MIC.lang)}`, { method: "POST", body: blob });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof j.detail === "string" ? j.detail : "Could not transcribe");
    if (!j.text) throw new Error("I did not hear any words, try again");
    MIC.warmDone = true;
    micInsert(kind, j.text);
  } catch (e) { toast(e.message); }
  finally { clearInterval(MIC.tick); MIC.busy = false; MIC.kind = null; micRepaint(); }
}
function micInsert(kind, text) {
  const join = (cur) => (cur && cur.trim() ? cur.trimEnd() + " " : "") + text;
  if (kind === "chat") { const ta = $("#chatInput"); ta.value = join(ta.value); ta.focus(); return; }
  S.cm.draft = join(S.cm.draft);
  if (!S.cm.open) cmOpen(true); else renderComments();
  $("#cmText")?.focus();
}

// ---------------------------------------------------------------------------
// Inspiration board: screenshots, example videos and written rules. The AI chat reads the rules every time
// and looks at the pictures when you ask it to take inspiration from the board.
// ---------------------------------------------------------------------------
const BOARD_TAB = "__board";
const projUrl = (rel) => `/media/${encodeURIComponent(ID)}/${rel.split("/").map(encodeURIComponent).join("/")}`;
async function loadBoard() {
  try { S.board.items = (await api("/inspiration")).items; S.board.rules = (await api("/inspiration-rules")).rules; } catch { /* offline */ }
  renderChat(); if (S.binTab === BOARD_TAB) renderBin();
}
const rulesActive = () => S.board.rules.filter((r) => r.status === "active");
const rulesDraft = () => S.board.rules.filter((r) => r.status === "draft");
// Step 2: the analysis reads the references and writes draft rules; you keep, edit or discard each one.
async function boardAnalyse(ids) {
  if (S.analyse.busy) return;
  S.analyse = { busy: true, msg: "", err: false }; S.board.view = "rules"; S.binTab = BOARD_TAB; setPanel("bin", true); document.activeElement?.blur?.(); renderBin();
  try {
    const st = await api("/inspiration-analyse", { method: "POST", body: JSON.stringify({ item_ids: ids || [] }) });
    let job;
    for (let n = 0; n < 300; n++) { await sleep(1500); job = await api("/inspiration-analyse"); if (job.id === st.id && !job.running) break; }
    if (!job || job.running) throw new Error("The analysis did not finish in time");
    if (!job.ok) throw new Error(job.error || "The analysis failed");
    S.analyse.msg = `Found ${job.result.added} rule${job.result.added === 1 ? "" : "s"}. ${job.result.summary || ""} Keep the ones you agree with.`;
    S.board.rules = (await api("/inspiration-rules")).rules;
  } catch (e) { S.analyse.msg = e.message; S.analyse.err = true; }
  finally { S.analyse.busy = false; document.activeElement?.blur?.(); renderBin(); renderChat(); }
}
async function ruleAdd() {
  try { S.board.rules.push(await api("/inspiration-rules", { method: "POST", body: JSON.stringify({ title: "", text: "", category: "other" }) })); } catch (e) { toast(e.message); return; }
  renderBin(); renderChat(); setTimeout(() => document.querySelector(".r-card .b-note")?.focus(), 0);
}
function ruleApply(r) {                                 // hand the rule to the chat: you still see it live and approve it
  if (S.chat.busy) { toast("Wait for the current AI request to finish"); return; }
  setChatOpen(true);
  $("#chatInput").value = `Apply this rule ${chatContext().length ? "to the selected clips" : "to the whole video"}: ${r.title}. ${r.text}`;
  chatSend();
}
function ruleCard(r) {
  const patch = (b) => api("/inspiration-rules/" + r.id, { method: "PATCH", body: JSON.stringify(b) }).then((x) => Object.assign(r, x)).catch((e) => toast(e.message));
  const remove = async () => { try { await api("/inspiration-rules/" + r.id, { method: "DELETE" }); } catch (e) { toast(e.message); return; } S.board.rules = S.board.rules.filter((x) => x.id !== r.id); renderBin(); renderChat(); };
  const draft = r.status === "draft";
  return el("div", { class: "b-card r-card" + (r.status === "off" ? " off" : "") + (draft ? " draft" : "") },
    el("div", { class: "r-head" }, el("span", { class: "r-cat " + r.category }, r.category), draft ? el("span", { class: "r-new" }, "new") : null),
    el("input", { class: "b-title", value: r.title || "", placeholder: "Name of the rule", onchange: (e) => patch({ title: e.target.value }) }),
    el("textarea", { class: "b-note", rows: "4", dir: "auto", placeholder: "What the AI should do", onchange: (e) => patch({ text: e.target.value }) }, r.text || ""),
    r.source ? el("div", { class: "r-src", title: r.source }, "from: " + r.source) : null,
    draft
      ? el("div", { class: "b-row" }, el("button", { class: "primary", onclick: async () => { await patch({ status: "active" }); renderBin(); renderChat(); } }, "✓ Keep"), el("span", { class: "grow" }), el("button", { class: "danger", onclick: remove }, "✕ Discard"))
      : el("div", { class: "b-row" },
          el("label", { title: "Turn the rule off without deleting it" }, el("input", { type: "checkbox", checked: r.status === "active", onchange: async (e) => { await patch({ status: e.target.checked ? "active" : "off" }); renderBin(); renderChat(); } }), " On"),
          el("span", { class: "grow" }),
          el("button", { title: "Ask the chat to apply this rule now (you approve the result)", onclick: () => ruleApply(r) }, "▶ Apply"),
          el("button", { class: "danger", title: "Delete the rule", onclick: remove }, "🗑")));
}
function rulesPanel() {
  const drafts = rulesDraft(), mine = S.board.rules.filter((r) => r.status !== "draft");
  return el("div", {},
    el("div", { class: "hint" }, "Step 2. The analysis reads your references and writes rules from them. Keep the ones you agree with, edit the wording if you like. The AI chat follows every rule that is On."),
    el("div", { class: "btns" },
      el("button", { class: "primary", disabled: S.analyse.busy, onclick: () => boardAnalyse(null) }, S.analyse.busy ? "Analysing…" : "✦ Analyse my references"),
      el("button", { onclick: ruleAdd }, "＋ Write a rule")),
    S.analyse.busy ? el("div", { class: "hint" }, "Looking at your pictures and videos. This takes up to a minute.") : null,
    S.analyse.msg ? el("div", { class: "hint" + (S.analyse.err ? " err" : "") }, S.analyse.msg) : null,
    ...(drafts.length ? [el("div", { class: "sec-t" }, `Waiting for your OK (${drafts.length})`), ...drafts.map(ruleCard)] : []),
    el("div", { class: "sec-t" }, `Your rules (${mine.length})`),
    ...(mine.length ? mine.map(ruleCard) : [el("div", { class: "hint" }, "No rules yet. Press Analyse, or write one yourself.")]));
}
async function boardUpload(files) {
  if (!files.length) return;
  toast(`Adding ${files.length} file${files.length > 1 ? "s" : ""} to the board…`);
  for (const f of files) {
    try {
      const r = await fetch(`${API}/inspiration/file?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.detail === "string" ? j.detail : `Could not add ${f.name}`);
      S.board.items.push(j);
    } catch (e) { toast(e.message); }
  }
  document.activeElement?.blur?.(); renderBin(); renderChat();
}
async function boardAddNote() {
  try { S.board.items.push(await api("/inspiration/note", { method: "POST", body: JSON.stringify({ title: "", note: "" }) })); } catch (e) { toast(e.message); return; }
  renderBin(); renderChat();
  setTimeout(() => document.querySelector(".b-card .b-note")?.focus(), 0);
}
function boardCard(it) {
  const patch = (body) => api("/inspiration/" + it.id, { method: "PATCH", body: JSON.stringify(body) }).then((r) => Object.assign(it, r)).catch((e) => toast(e.message));
  const thumb = it.src ? el("img", { class: "b-thumb", src: `/thumb/${encodeURIComponent(ID)}/${it.src.split("/").map(encodeURIComponent).join("/")}?w=320`, title: "Open full size", onclick: () => window.open(projUrl(it.src), "_blank") }) : null;
  return el("div", { class: "b-card" + (it.use === false ? " off" : "") },
    thumb,
    el("input", { class: "b-title", value: it.title || "", placeholder: it.kind === "note" ? "Name of the rule" : "Name", onchange: (e) => patch({ title: e.target.value }) }),
    el("textarea", { class: "b-note", rows: it.kind === "note" ? "6" : "3", dir: "auto",
      placeholder: it.kind === "note" ? "For example: subtitles always sit in the lower third, white, the key word in yellow, never over the face" : "What should the AI learn from this? For example: where the subtitles sit, how the video is cropped",
      onchange: (e) => patch({ note: e.target.value }) }, it.note || ""),
    el("div", { class: "b-row" },
      el("label", { title: "Untick to keep it on the board but hide it from the AI" }, el("input", { type: "checkbox", checked: it.use !== false, onchange: (e) => { patch({ use: e.target.checked }).then(() => renderBin()); } }), " Use"),
      el("span", { class: "grow" }), it.kind === "video" ? el("span", { class: "b-kind" }, "video") : null,
      el("button", { title: "Write rules from just this reference", disabled: S.analyse.busy, onclick: () => boardAnalyse([it.id]) }, "✦ Analyse"),
      el("button", { class: "danger", title: "Remove from the board", onclick: async () => {
        if (!confirm("Remove this from the board?")) return;
        try { await api("/inspiration/" + it.id, { method: "DELETE" }); } catch (e) { toast(e.message); return; }
        S.board.items = S.board.items.filter((x) => x.id !== it.id); renderBin(); renderChat();
      } }, "🗑")));
}
function boardPanel() {
  const fileIn = el("input", { type: "file", multiple: "", accept: "image/*,video/*", class: "hidden", onchange: (e) => { boardUpload([...e.target.files]); e.target.value = ""; } });
  const nA = rulesActive().length, nD = rulesDraft().length, v = S.board.view;
  const tabs = el("div", { class: "b-tabs" },
    el("button", { class: v === "refs" ? "on" : "", onclick: () => { S.board.view = "refs"; renderBin(); } }, `1 References (${S.board.items.length})`),
    el("button", { class: v === "rules" ? "on" : "", onclick: () => { S.board.view = "rules"; renderBin(); } }, `2 Rules (${nA}${nD ? `, ${nD} new` : ""})`));
  if (v === "rules") return el("div", { class: "board" }, tabs, rulesPanel());
  const cards = [...S.board.items].reverse().map(boardCard);
  return el("div", { class: "board" }, tabs,
    el("div", { class: "hint" }, "Step 1. Things the AI can learn from: screenshots (like a CapCut example), reference videos, and notes. Drop files here, press ⌘V to paste a screenshot, or use the buttons. Then press Analyse to turn them into rules."),
    el("div", { class: "btns" },
      el("button", { class: "primary", onclick: () => fileIn.click() }, "＋ Pictures / videos"),
      el("button", { onclick: boardAddNote }, "＋ Write a note"),
      el("button", { disabled: !S.board.items.length || S.analyse.busy, title: "Read all references and write rules from them", onclick: () => boardAnalyse(null) }, "✦ Analyse all"), fileIn),
    ...(cards.length ? cards : [el("div", { class: "hint" }, "Nothing on the board yet.")]));
}

function bindKeys() {
  window.addEventListener("keydown", (e) => {
    if (KEYS.capture) { keyCaptured(e); return; }
    const tag = (e.target.tagName || "").toLowerCase();
    if (["input", "textarea", "select"].includes(tag)) return;
    if (e.key === "Delete") { e.preventDefault(); deleteSelection(); return; }   // always works, next to your own delete key
    const combo = comboOf(e);
    const act = ACTIONS.find((a) => keyFor(a.id) === combo);
    if (act) { e.preventDefault(); act.run(e); }
  });
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts you can define yourself (⌨ Keys). Saved in this browser.
// ---------------------------------------------------------------------------
const KEYS = { map: {}, open: false, capture: null, mods: new Set(), focus: "" };
const SHORT = { play: "Play", split: "Cut", mute: "Mute", delete: "Delete", duplicate: "Copy", undo: "Undo", redo: "Redo", save: "Save", flip: "Flip", rotate: "Turn", lock: "Lock", notes: "Note", media: "Media", settings: "Settings", frameBack: "-1 frame", frameFwd: "+1 frame", secBack: "-1 s", secFwd: "+1 s", prevClip: "Prev clip", nextClip: "Next clip", deselect: "Deselect" };
const KB_ROWS = [
  ["`", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "=", ["backspace", "⌫", 1.6]],
  [["tab", "⇥", 1.5], "q", "w", "e", "r", "t", "y", "u", "i", "o", "p", "[", "]", "\\"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l", ";", "'", ["enter", "↩", 1.9]],
  ["z", "x", "c", "v", "b", "n", "m", ",", ".", "/"],
  [["esc", "esc", 1.2], ["left", "←", 1], ["up", "↑", 1], ["down", "↓", 1], ["right", "→", 1], ["space", "space", 5]],
];
try { KEYS.map = JSON.parse(localStorage.getItem("montage-keys") || "{}") || {}; } catch { KEYS.map = {}; }
const CODE_KEY = { Space: "space", ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Backspace: "backspace", Delete: "delete", Escape: "esc", Enter: "enter", Tab: "tab",
  BracketLeft: "[", BracketRight: "]", Comma: ",", Period: ".", Slash: "/", Minus: "-", Equal: "=", Backquote: "`", Semicolon: ";", Quote: "'", Backslash: "\\" };
function comboOf(e) {
  let k = CODE_KEY[e.code] || (/^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F\d+$/.test(e.code) ? e.code.toLowerCase() : "");
  if (!k || ["Meta", "Control", "Shift", "Alt"].includes(e.key)) return "";
  return [(e.metaKey || e.ctrlKey) ? "mod" : "", e.altKey ? "alt" : "", e.shiftKey ? "shift" : "", k].filter(Boolean).join("+");
}
const KEY_PRETTY = { mod: "⌘", alt: "⌥", shift: "⇧", space: "Space", left: "←", right: "→", up: "↑", down: "↓", backspace: "⌫", delete: "⌦", esc: "Esc", enter: "↩", tab: "⇥" };
const prettyCombo = (c) => c ? c.split("+").map((p) => KEY_PRETTY[p] || p.toUpperCase()).join(" ") : "none";
const keyFor = (id) => (id in KEYS.map ? KEYS.map[id] : ACTIONS.find((a) => a.id === id)?.key) || "";
const keyTarget = () => { const t = quickTarget(); return t; };
const ACTIONS = [
  { id: "play", label: "Play / pause", key: "space", run: () => player?.toggle() },
  { id: "split", label: "Cut the clip at the playhead", key: "c", run: () => splitAtPlayhead() },
  { id: "mute", label: "Mute / unmute the clip sound", key: "m", run: () => { const t = keyTarget(); if (!t) return; if (t.kind === "clip") toggleClipSound(t.id); else commit((tl) => { const x = tl.layers.find((q) => q.id === t.id); x.volume = x.volume > 0 ? 0 : 1; }); } },
  { id: "delete", label: "Delete the selection", key: "backspace", run: () => deleteSelection() },
  { id: "duplicate", label: "Duplicate the clip", key: "mod+d", run: () => { const t = keyTarget(); if (t?.kind === "clip") duplicateClip(t.id); } },
  { id: "undo", label: "Undo", key: "mod+z", run: () => undo() },
  { id: "redo", label: "Redo", key: "mod+shift+z", run: () => redo() },
  { id: "save", label: "Save", key: "mod+s", run: () => save() },
  { id: "flip", label: "Flip the picture", key: "f", run: () => quickFlip(false) },
  { id: "rotate", label: "Turn the picture 90 degrees", key: "r", run: () => quickRotate() },
  { id: "lock", label: "Lock / unlock the selection", key: "l", run: () => { if (S.sel) toggleLock(S.sel.t, S.sel.id); } },
  { id: "notes", label: "Add a review note at the playhead", key: "n", run: () => cmOpen(true) },
  { id: "media", label: "Show / hide the Media panel", key: "b", run: () => setPanel("bin", !S.panels.bin) },
  { id: "settings", label: "Show / hide the Settings panel", key: "i", run: () => setPanel("insp", !S.panels.insp) },
  { id: "frameBack", label: "One frame back", key: "left", run: () => seek(S.time - 1 / (S.tl.format?.fps ?? 30)) },
  { id: "frameFwd", label: "One frame forward", key: "right", run: () => seek(S.time + 1 / (S.tl.format?.fps ?? 30)) },
  { id: "secBack", label: "One second back", key: "shift+left", run: () => seek(S.time - 1) },
  { id: "secFwd", label: "One second forward", key: "shift+right", run: () => seek(S.time + 1) },
  { id: "prevClip", label: "Previous clip", key: "[", run: () => $("#prevClip").click() },
  { id: "nextClip", label: "Next clip", key: "]", run: () => $("#nextClip").click() },
  { id: "deselect", label: "Deselect", key: "esc", run: () => { S.sel = null; S.multi = [], S.multiX = []; renderAll(); } },
];
function saveKeys() { try { localStorage.setItem("montage-keys", JSON.stringify(KEYS.map)); } catch { /* storage blocked: the keys last until reload */ } }
function keyCaptured(e) {
  e.preventDefault(); e.stopPropagation();
  const id = KEYS.capture;
  if (e.key === "Escape") { KEYS.capture = null; return renderKeys(); }
  const combo = e.key === "Backspace" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && id !== "delete" ? "" : comboOf(e);   // Backspace alone clears (except for the delete action itself)
  if (combo === "" && e.key !== "Backspace") return;                                                                                 // only a modifier so far: keep waiting
  assignKey(id, combo);
}
function assignKey(id, combo) {
  if (combo) { const clash = ACTIONS.find((a) => a.id !== id && keyFor(a.id) === combo); if (clash) { KEYS.map[clash.id] = ""; toast(`${prettyCombo(combo)} was "${clash.label}". It is now free, set a new key for it.`); } }
  KEYS.map[id] = combo; KEYS.capture = null; KEYS.focus = id; saveKeys(); renderKeys();
}
// The picture of the keyboard: blue = used by an action, dark = free. Toggle ⇧ ⌘ ⌥ to see the keys that work together with them.
function keyboardView() {
  const prefix = ["mod", "alt", "shift"].filter((m) => KEYS.mods.has(m)).join("+");
  const used = new Map(ACTIONS.map((a) => [keyFor(a.id), a]).filter(([k]) => k));
  const cell = (spec) => {
    const [k, label, w] = Array.isArray(spec) ? spec : [spec, spec.toUpperCase(), 1];
    const combo = (prefix ? prefix + "+" : "") + k, act = used.get(combo);
    return el("button", { class: "kk" + (act ? " used" : " free") + (act && act.id === KEYS.focus ? " focus" : ""), style: { flex: String(w) },
      title: act ? `${prettyCombo(combo)}: ${act.label}` : `${prettyCombo(combo)}: free`,
      onclick: () => {
        if (KEYS.capture) return assignKey(KEYS.capture, combo);
        if (act) { KEYS.focus = act.id; renderKeys(); } else toast(`${prettyCombo(combo)} is free. Click an action in the list, then click this key.`);
      } }, el("span", { class: "kl" }, label), act ? el("span", { class: "ks" }, SHORT[act.id] || act.label) : null);
  };
  const mod = (m, label) => el("button", { class: "kmod" + (KEYS.mods.has(m) ? " on" : ""), onclick: () => { KEYS.mods.has(m) ? KEYS.mods.delete(m) : KEYS.mods.add(m); renderKeys(); } }, label);
  return el("div", { class: "kbd" },
    el("div", { class: "kbd-top" }, el("span", {}, "Show keys with:"), mod("mod", "⌘"), mod("alt", "⌥"), mod("shift", "⇧"), el("span", { class: "kleg" }, el("i", { class: "u" }), " used ", el("i", { class: "f" }), " free")),
    ...KB_ROWS.map((r) => el("div", { class: "krow" }, ...r.map(cell))));
}
function renderKeys() {
  let box = $("#keysBox");
  if (!box) { box = el("div", { id: "keysBox", class: "keysbox hidden" }); document.body.append(box); }
  box.classList.toggle("hidden", !KEYS.open);
  if (!KEYS.open) return;
  box.replaceChildren(
    el("div", { class: "kb-head" }, el("b", {}, "⌨ Keyboard shortcuts"), el("button", { class: "x", onclick: () => { KEYS.open = false; KEYS.capture = null; renderKeys(); } }, "×")),
    el("div", { class: "kb-hint" }, "Green keys are used, dark keys are free. Click an action below, then press a key or click one on the picture. Backspace clears it. Esc cancels. Saved in this browser."),
    keyboardView(),
    el("div", { class: "kb-list" }, ...ACTIONS.map((a) => el("div", { class: "kb-row" + (a.id === KEYS.focus ? " focus" : ""), onclick: () => { KEYS.focus = a.id; renderKeys(); } },
      el("span", {}, a.label),
      el("button", { class: "kb-key" + (KEYS.capture === a.id ? " on" : ""), onclick: (e) => { e.stopPropagation(); KEYS.capture = a.id; KEYS.focus = a.id; renderKeys(); } }, KEYS.capture === a.id ? "press a key..." : prettyCombo(keyFor(a.id)))))),
    el("div", { class: "kb-foot" }, el("button", { onclick: () => { KEYS.map = {}; KEYS.capture = null; saveKeys(); renderKeys(); } }, "Reset all to default")));
}

// Heavy videos get a light preview copy made on the server the first time they are asked for; ask now, so it is ready sooner.
function warmPreviews() {
  const srcs = new Set([...(S.tl.clips || []), ...(S.tl.layers || [])].filter((c) => c.kind === "video" && c.src).map((c) => c.src));
  srcs.forEach((src) => fetch(MEDIA_BASE + src.split("/").map(encodeURIComponent).join("/"), { headers: { Range: "bytes=0-0" } }).catch(() => {}));
}

function start() {
  warmPreviews();
  if (!player) {
    player = window.MontagePlayer.mount($("#player"), {
      timeline: clone(S.tl), mediaBase: MEDIA_BASE, onTime,
      onPlayState: (p) => { S.playing = p; $("#play").textContent = p ? "❚❚" : "▶"; },
    });
  }
  renderAll();
}

async function main() {
  if (!window.MontagePlayer) { document.body.textContent = "montage-player.js is missing — run `npm run build:editor` in remotion-composer/"; return; }
  $("#back").href = `/p/${encodeURIComponent(ID)}`;
  $("#undo").onclick = undo; $("#redo").onclick = redo;
  $("#play").onclick = () => {
    if (!S.playing) {                                    // nothing to hear? say why instead of leaving a silent preview
      const it = lay().items.find((x) => S.time >= x.start && S.time < x.start + x.duration);
      if (it?.clip.kind === "video" && !(it.clip.volume > 0) && !S.tl.music) toast("This clip's sound is off. Click the 🔇 on the clip, or set Clip sound in Settings.");
    }
    player?.toggle();
  };
  $("#binGrip").addEventListener("pointerdown", (e) => {
    e.preventDefault(); const x0 = e.clientX, w0 = S.binW;
    const mv = (ev) => { S.binW = clamp(w0 + ev.clientX - x0, 220, Math.min(900, innerWidth - 500)); layoutPanels(); };
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); try { localStorage.setItem("montage-bin-w", String(S.binW)); } catch { /* storage blocked */ } };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  });
  $("#flipBtn").onclick = (e) => quickFlip(e.shiftKey); $("#rotBtn").onclick = quickRotate; $("#revBtn").onclick = quickReverse; $("#expandBtn").onclick = quickExpand; $("#cropBtn").onclick = quickCrop;
  $("#dupBtn").onclick = () => { const t = quickTarget(); if (!t) return; if (t.kind !== "clip") return toast("Duplicate works on clips on Video 1"); duplicateClip(t.id); };
  $("#groupBtn").onclick = groupSelection;
  $("#cmtBtn").onclick = () => cmOpen(!S.cm.open);
  $("#aiBtn").onclick = () => setChatOpen(!S.chat.open);
  $("#binBtn").onclick = () => setPanel("bin", !S.panels.bin);
  let binSeq = 0, binTimer = 0;
  $("#binSearch").oninput = (e) => {
    S.binQ = e.target.value; clearTimeout(binTimer);
    binTimer = setTimeout(async () => {
      const mine = ++binSeq, q = S.binQ.trim();
      if (!q) { S.binHits = []; return renderBin(); }
      try { const r = await api(`/library-search?q=${encodeURIComponent(q)}`); if (mine === binSeq) { S.binHits = r.cuts; renderBin(); } } catch { /* offline: keep what is shown */ }
    }, 180);
  };
  $("#boardBtn").onclick = () => { if (S.panels.bin && S.binTab === BOARD_TAB) { setPanel("bin", false); return; } S.binTab = BOARD_TAB; setPanel("bin", true); renderBin(); };
  // Drop files from Finder onto the media panel: they are copied into the folder that is open (or "uploads" for All media).
  $("#bin").addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); $("#bin").classList.add("drop-files"); } });
  $("#bin").addEventListener("dragleave", (e) => { if (!$("#bin").contains(e.relatedTarget)) $("#bin").classList.remove("drop-files"); });
  $("#bin").addEventListener("drop", (e) => {
    $("#bin").classList.remove("drop-files");
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    if (S.binTab === BOARD_TAB) { boardUpload([...e.dataTransfer.files]); return; }
    dropToBin([...e.dataTransfer.files]);
  });
  window.addEventListener("paste", (e) => {      // paste a screenshot straight onto the board
    if (!S.panels.bin || S.binTab !== BOARD_TAB || ["input", "textarea"].includes((e.target.tagName || "").toLowerCase())) return;
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
    if (!files.length) return;
    e.preventDefault();
    boardUpload(files.map((f) => (/^image\.\w+$/.test(f.name) ? new File([f], `pasted-${Date.now()}.${f.type.split("/")[1] || "png"}`, { type: f.type }) : f)));
  });
  $("#inspBtn").onclick = () => setPanel("insp", !S.panels.insp);
  $("#sndBtn").onclick = () => { if (S.panels.snd) setPanel("snd", false); else { S.panels.snd = true; layoutPanels(); renderSound(); } };
  let lastBlkDown = 0;     // two quick presses on a block open Settings (the timeline redraws on the first press, so a dblclick event never fires)
  $("#tlInner").addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".blk")) return;
    const now = Date.now(); if (now - lastBlkDown < 450 && !S.panels.insp) setPanel("insp", true); lastBlkDown = now;
  }, true);
  layoutPanels();
  $("#keysBtn").onclick = () => { KEYS.open = !KEYS.open; KEYS.capture = null; renderKeys(); };
  $("#verBtn").onclick = () => { S.ver.open = !S.ver.open; renderVersions(); if (S.ver.open) loadVersions(); };
  initChat();
  $("#fsBtn").onclick = () => { player?.fullscreen(); player?.play(); };
  $("#prevClip").onclick = () => jumpClip(-1); $("#nextClip").onclick = () => jumpClip(1);
  $("#splitBtn").onclick = splitAtPlayhead; $("#delBtn").onclick = deleteSelection; $("#addText").onclick = addText;
  $("#previewBtn").onclick = () => startRender(true); $("#exportBtn").onclick = () => startRender(false); $("#dlBtn").onclick = quickDownload; $("#stillBtn").onclick = downloadStill;
  $("#zoom").oninput = (e) => { S.pps = parseFloat(e.target.value); renderTimeline(); };
  for (const ev of ["wheel", "pointerdown", "touchstart"]) $("#tlScroll").addEventListener(ev, () => { S.userScrollAt = Date.now(); }, { passive: true });
  $("#play").addEventListener("click", () => { S.userScrollAt = 0; }); // pressing play follows the playhead again
  $("#ruler").addEventListener("pointerdown", rulerSeek);
  $("#tlInner").addEventListener("pointerdown", (e) => { if (e.target.classList.contains("track")) { e.preventDefault(); startMarquee(e); } });
  $("#playhead .ph-knob").addEventListener("pointerdown", (e) => { e.stopPropagation(); rulerSeek(e); });
  window.addEventListener("resize", () => { if (S.tl) { renderTimeline(); renderXform(); } });
  new ResizeObserver(() => { if (S.tl) { renderRulers(); renderXform(); } }).observe($("#playerBox"));
  $("#rulerBtn").onclick = () => { S.rulers = !S.rulers; try { localStorage.setItem("montage-rulers", S.rulers ? "1" : "0"); } catch { /* storage blocked */ } renderRulers(); renderXform(); };
  $("#playerBox").addEventListener("pointermove", pxTrack);
  $("#playerBox").addEventListener("pointerleave", () => { $("#pxRead").textContent = ""; });
  $("#inspector").addEventListener("focusout", () => setTimeout(() => S.tl && renderInspector(), 0));
  window.addEventListener("beforeunload", (e) => { if (S.dirty) { save(); e.preventDefault(); } });
  bindKeys();

  await loadMedia().catch(() => {});
  loadBoard();
  await loadTemplates().catch(() => {});
  loadSwitcher();
  const ok = await loadTimeline().catch((e) => { showEmpty(e.message); return false; });
  if (ok) { start(); autoSnapshotOnOpen(); }
  api("/render").then((r) => { S.render = r; renderRender(); if (r.running) pollRender(); }).catch(() => {});

  // The timeline live-syncs, but the editor's own code does not: tell the user when this tab runs old code
  // (an old tab can show effects that were already fixed, or save stale data over new edits).
  let build = null;
  const checkBuild = async () => {
    try {
      const b = (await (await fetch("/api/health", { cache: "no-store" })).json()).build;
      if (build == null) build = b;
      else if (b !== build && $("#banner").classList.contains("hidden")) {
        const bn = $("#banner"); bn.classList.remove("hidden"); document.body.classList.add("has-banner");
        bn.replaceChildren(el("span", {}, "The editor was updated. Reload this tab (⌘/Ctrl+Shift+R) so you see the latest version and do not save old data over it."), el("button", { class: "primary", onclick: () => location.reload() }, "Reload now"));
      }
    } catch { /* server restarting */ }
  };
  checkBuild(); setInterval(checkBuild, 10000);

  // Live sync: Claude (or anything else) editing timeline.json updates the editor.
  const es = new EventSource(`/api/project/${encodeURIComponent(ID)}/events`);
  let t = null;
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data || "{}");
    if (msg.type !== "change") return;
    clearTimeout(t); t = setTimeout(() => { refreshFromDisk(); }, 250);   // the media list is refreshed by the ↻ Refresh button, not on every file change
  };
}
main();
