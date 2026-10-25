// Montage editor — CapCut-style timeline editor for artifacts/timeline.json.
// The preview is a live Remotion <Player> running the same FamilyMontage
// composition as the final render (window.MontagePlayer, montage-player.js).

const $ = (s) => document.querySelector(s);
const ID = decodeURIComponent(location.pathname.split("/").filter(Boolean)[1] || "");
const API = `/api/editor/${encodeURIComponent(ID)}`;
const MEDIA_BASE = `/media/${encodeURIComponent(ID)}/public/`;
const thumbUrl = (src, w = 320) => `/thumb/${encodeURIComponent(ID)}/public/${src.split("/").map(encodeURIComponent).join("/")}?w=${w}`;

const TRANSITIONS = ["cut", "fade", "flash", "zoom", "whip", "slide-left", "slide-up", "dip-black", "shutter", "whip-right", "whip-up", "zoom-through", "spin", "flip", "iris", "wipe-diag", "glitch", "blur-dissolve", "light-leak", "shake", "window", "reveal-up", "tunnel"];
const MOTIONS = ["none", "punch", "zoom-in", "zoom-out", "pan-left", "pan-right"];
const FITS = ["cover", "contain", "blur-fill"];
const TEXT_STYLES = ["pop", "subtitle", "title", "cine"];
const POSITIONS = ["top", "center", "bottom"];
const GRADES = ["none", "warm", "cool", "vivid", "film", "bw"];
const FONTS = ["Heebo", "Rubik", "Assistant", "Anton", "Montserrat"];
const ASPECTS = { "9:16": [1080, 1920], "16:9": [1920, 1080], "1:1": [1080, 1080], "4:5": [1080, 1350] };
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
let player = null;

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
const clone = (o) => JSON.parse(JSON.stringify(o));
const r3 = (n) => Math.round(n * 1000) / 1000;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`; };
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
const mediaInfo = (src) => S.media.find((m) => m.src === src);
const groupOf = (id) => (S.tl.groups || []).find((g) => g.id === id);
// Music pieces: index 0 = the main track (tl.music), 1.. = pieces made by cutting it (tl.music_more[i-1]).
const musicAt = (tl, i = 0) => (i === 0 ? tl.music : (tl.music_more || [])[i - 1]);
const musicCount = (tl) => (tl.music ? 1 : 0) + (tl.music_more || []).length;
const selMusic = () => S.sel?.t === "music" ? (S.sel.i || 0) : 0;
// Where a music piece starts/ends on the montage clock (0 = just after the opener).
function musicSpan(tl, i) {
  const m = musicAt(tl, i), opener = tl.opener ? tl.opener.seconds : 0, total = window.MontagePlayer.layoutTimeline(tl).total - opener;
  const start = i === 0 ? Math.max(-opener, (m.start_at === "opener" ? -opener : 0) + (m.shift || 0)) : (m.at || 0);
  return { start: Math.max(0, start), end: m.until != null ? Math.min(total, m.until) : total, total };
}
const groupClips = (gid) => S.tl.clips.filter((c) => c.group === gid);
// ---- Locks: a locked item cannot be moved, trimmed, edited or deleted until released.
// A locked clip is also PINNED (clip.at): clips before it can change without shifting it - a gap opens instead.
const isLocked = (c) => !!c.locked || !!(c.group && groupOf(c.group)?.locked);
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
S.multi = []; // ids of clips picked with shift-click (a consecutive range), for "Group"

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
  player?.update(clone(S.tl));
  renderAll();
  if (save) { S.dirty = true; scheduleSave(); }
}
function undo() { if (!S.undo.length) return; const cm = S.tl.comments; S.redo.push(clone(S.tl)); S.tl = S.undo.pop(); keepComments(cm); S.lastKey = null; changed(); }
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
  if (!S.tl || S.saving || S.conflict) return;
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
  S.undo.push(clone(S.tl)); S.tl = r.timeline; S.mtime = r.mtime;
  changed({ save: false }); toast("Timeline updated");
}
async function loadMedia() { S.media = (await api("/media")).media; renderBin(); }

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
  const done = async (added, found) => {
    await loadMedia();
    if (!S.tl) emptyCount();
    say(added ? `Added ${added} file${added === 1 ? "" : "s"} to the media bin.` : `Nothing new: all ${found} files are already in the bin.`);
    list();
  };
  const body = el("div", {});
  async function list() {
    const src = await api("/sources").catch(() => ({ folders: [], in_bin: 0 }));
    const path = el("input", { type: "text", placeholder: "/Users/you/Pictures/Poland", dir: "ltr" });
    body.replaceChildren(
      el("div", { class: "sec-t" }, `In the media bin: ${src.in_bin}`),
      el("div", { class: "sec-t" }, "This project's source media"),
      ...(src.folders.length ? src.folders.map((f) => el("div", { class: "imp-row" }, el("span", {}, `${f.path} · ${f.count} files`),
        el("button", { onclick: async () => { say("Importing…"); try { const r = await api("/import", { method: "POST", body: JSON.stringify({ folder: f.path }) }); done(r.added, r.found); } catch (e) { say(e.message, true); } } }, "Import")))
        : [el("div", { class: "hint" }, "No source-media folders in this project.")]),
      el("div", { class: "sec-t" }, "A folder on this Mac"),
      el("div", { class: "imp-row" }, path, el("button", { onclick: async () => {
        say("Importing…"); try { const r = await api("/import", { method: "POST", body: JSON.stringify({ folder: path.value }) }); done(r.added, r.found); } catch (e) { say(e.message, true); }
      } }, "Import")),
      el("div", { class: "sec-t" }, "Google Photos"),
      el("div", { class: "imp-row" }, el("span", {}, "Opens a Google tab on this Mac. Pick the photos/videos, press Done."),
        el("button", { id: "gpBtn", onclick: googlePhotos }, "Open picker")),
      msg);
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
function renderBin() {
  const folders = ["all", ...new Set(S.media.map((m) => m.folder || "(root)"))];
  $("#binTabs").replaceChildren(
    el("button", { class: "imp-btn", title: "Import photos/videos", onclick: openImporter }, "＋ Import"),
    el("button", { class: S.binTab === MOTION_TAB ? "on" : "", onclick: () => { S.binTab = MOTION_TAB; renderBin(); } }, "✨ Motion"),
    ...folders.map((f) =>
      el("button", { class: S.binTab === f ? "on" : "", onclick: () => { S.binTab = f; renderBin(); } }, f === "all" ? "All" : f)));
  if (S.binTab === MOTION_TAB) {
    const a = document.activeElement;
    if (a && $("#binGrid").contains(a) && ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName)) return;
    $("#binGrid").classList.add("motion");
    return $("#binGrid").replaceChildren(motionPanel());
  }
  $("#binGrid").classList.remove("motion");
  const used = new Set((S.tl?.clips || []).map((c) => c.src).concat(S.tl?.music ? [S.tl.music.src] : []).concat((S.tl?.music_more || []).map((m) => m.src)));
  const items = S.media.filter((m) => S.binTab === "all" || (m.folder || "(root)") === S.binTab);
  $("#binGrid").replaceChildren(...items.map((m) => {
    const card = el("div", { class: "card", draggable: "true", title: m.src,
      onclick: () => previewMedia(m),
      ondragstart: (e) => { e.dataTransfer.setData("text/montage-src", m.src); e.dataTransfer.effectAllowed = "copy"; } },
      m.kind === "audio" ? el("div", { class: "audio-ico" }, "♫") : el("img", { src: thumbUrl(m.src), loading: "lazy" }),
      used.has(m.src) ? el("div", { class: "used" }, "IN") : null,
      el("div", { class: "add", title: "Add to the timeline", onclick: (e) => { e.stopPropagation(); addMedia(m); } }, "+"),
      el("div", { class: "meta" }, el("span", {}, m.name), el("span", {}, m.kind === "image" ? "📷" : m.duration ? fmt(m.duration) : "")));
    return card;
  }));
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
  if (m.kind === "image") return { id: newId(), src: m.src, kind: "image", label: m.name.replace(/\.[^.]+$/, ""), hold: 2.5, fit: "cover", motion: "zoom-in", transition: { type: "fade", seconds: 0.3 } };
  const d = m.duration || 3;
  const win = Math.min(3, d); const a = Math.max(0, (d - win) / 2);
  return { id: newId(), src: m.src, kind: "video", label: m.name.replace(/\.[^.]+$/, ""), in: r3(a), out: r3(a + win), source_duration: r3(d), speed: 1, volume: 0, fit: "cover", motion: "punch", transition: { type: "flash", seconds: 0.3 } };
}
// Click a bin item: look at it in the stage first (play it, scrub it); "Add to timeline" is explicit.
function closePreview() { $("#mediaPreview")?.querySelector("video,audio")?.pause?.(); $("#mediaPreview")?.remove(); }
function previewMedia(m) {
  closePreview();
  const url = MEDIA_BASE + m.src.split("/").map(encodeURIComponent).join("/");
  player?.pause?.();
  const body = m.kind === "image" ? el("img", { src: url })
    : m.kind === "audio" ? el("audio", { src: url, controls: "", autoplay: "" })
    : el("video", { src: url, controls: "", autoplay: "", loop: "", playsinline: "" });
  $("#stage").appendChild(el("div", { id: "mediaPreview" },
    el("div", { class: "mp-head" }, el("span", {}, `${m.name}${m.duration ? " · " + fmt(m.duration) : ""}`),
      el("div", { class: "btns" },
        el("button", { class: "primary", onclick: () => { closePreview(); addMedia(m); } }, "＋ Add to timeline"),
        el("button", { onclick: closePreview }, "✕ Close"))),
    el("div", { class: "mp-body" }, body)));
}
function addMedia(m, atIndex = null) {
  if (m.kind === "audio") {
    if (S.sel?.t === "music" && selMusic() > 0 && musicAt(S.tl, selMusic())) { const i = selMusic(); commit((tl) => { musicAt(tl, i).src = m.src; musicAt(tl, i).offset = 0; }); renderAll(); toast("Song changed for this piece"); return; }
    commit((tl) => { tl.music = { src: m.src, offset: 0, volume: 0.8, duck_volume: 0.25, fade_in: 0.5, fade_out: 2, start_at: "clips" }; });
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
function renderTime() { $("#time").textContent = `${fmt(S.time)} / ${fmt(lay().total)}`; }
function onTime(t) { S.time = t; requestAnimationFrame(renderPlayhead); }
function renderPlayhead() {
  $("#playhead").style.left = `${S.time * S.pps}px`;
  renderTime();
  // Keep the playhead visible while playing, but never fight the user: after they scroll, leave the view alone.
  if (S.playing && Date.now() - (S.userScrollAt || 0) > 4000) {
    const sc = $("#tlScroll"), x = S.time * S.pps;
    if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - 80;
  }
}
function jumpClip(dir) {
  const starts = lay().items.map((it) => it.start).sort((a, b) => a - b);
  const t = dir > 0 ? starts.find((s) => s > S.time + 0.05) : [...starts].reverse().find((s) => s < S.time - 0.05);
  if (t != null) seek(t + 0.001);
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------
function renderTimeline() {
  const { items, total, openerSeconds } = lay();
  const pps = S.pps;
  const SLACK = 1; // seconds of room after the last clip (just enough to drop a clip at the end)
  const width = Math.max($("#tlScroll").clientWidth, (total + SLACK) * pps);
  $("#tlInner").style.width = width + "px";

  // Ruler
  const step = pps >= 160 ? 0.5 : pps >= 60 ? 1 : pps >= 30 ? 2 : 5;
  const ticks = [];
  for (let s = 0; s <= total + SLACK; s += step) {
    const major = Math.abs(s / (step * 5) - Math.round(s / (step * 5))) < 1e-6 || step >= 2;
    ticks.push(el("div", { class: "tick" + (major ? " major" : ""), style: { left: s * pps + "px" } }, major ? el("span", {}, fmt(s).replace(/\.0$/, "")) : null));
  }
  $("#ruler").replaceChildren(...ticks);

  // Video track
  const vids = [];
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
        el("div", { class: "lbl" }, "▣ " + gr.name), el("div", { class: "dur" }, `${(last.start + last.duration - first.start).toFixed(1)}s · ${mem.length} clips`)));
      return;
    }
    const sel = S.sel?.t === "clip" && S.sel.id === c.id;
    const blk = el("div", {
      class: `blk ${c.kind}${it.isOpener ? " opener" : ""}${sel ? " sel" : ""}${S.multi.includes(c.id) ? " multi" : ""}${gr ? " grouped" : ""}${isLocked(c) ? " locked" : ""}`,
      // Show the cut in the middle of each transition so blocks don't overlap (like CapCut).
      style: { left: (it.start + it.transIn / 2) * pps + "px", width: Math.max(8, (it.duration - it.transIn / 2 - it.transOut / 2) * pps - 2) + "px", backgroundImage: it.isOpener ? "" : `url("${thumbUrl(c.src)}")`, zIndex: String(idx + 1) },
      "data-id": c.id,
    },
      el("div", { class: "lbl" }, it.isOpener ? "Opener" : (c.text?.value ? "T · " : "") + (c.label || c.src.split("/").pop())),
      el("div", { class: "dur" }, `${it.duration.toFixed(1)}s${c.speed && c.speed !== 1 ? ` · ${c.speed}x` : ""}`),
      !it.isOpener && c.volume > 0 ? el("div", { class: "badge" }, "🔊") : null,
      !it.isOpener && isLocked(c) ? el("div", { class: "lockic" }, "🔒") : null,
      !it.isOpener && !isLocked(c) ? el("div", { class: "h l", "data-h": "l" }) : null,
      !it.isOpener && !isLocked(c) ? el("div", { class: "h r", "data-h": "r" }) : null,
    );
    if (!it.isOpener) blk.addEventListener("pointerdown", (e) => clipPointerDown(e, c.id));
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
    const blk = el("div", { class: "blk text" + (sel ? " sel" : "") + (t.locked ? " locked" : ""), style: { left: (openerSeconds + w.start) * pps + "px", width: Math.max(8, (w.end - w.start) * pps) + "px" } },
      el("div", { class: "lbl" }, (t.follow ? "⛓ " : "") + t.value.replace(/\n/g, " · ")), t.locked ? el("div", { class: "lockic" }, "🔒") : null,
      t.locked ? null : el("div", { class: "h l", "data-h": "l" }), t.locked ? null : el("div", { class: "h r", "data-h": "r" }));
    blk.addEventListener("pointerdown", (e) => textPointerDown(e, t.id));
    return blk;
  });
  $("#trackText").replaceChildren(...texts);

  // Music track: one block per song piece. Pieces alternate between two lanes so a crossfade shows as a visible overlap,
  // each block says which song it is plus where it starts and ends, and each piece gets its own colour.
  const mus = [], nm = musicCount(S.tl), songName = (src) => src.split("/").pop().replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
  const hue = (src) => { let h = 0; for (const ch of src) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  for (let i = 0; i < nm; i++) {
    const m = musicAt(S.tl, i), sp = musicSpan(S.tl, i), from = openerSeconds + sp.start, to = openerSeconds + sp.end;
    const selM = S.sel?.t === "music" && (S.sel.i || 0) === i, lane = nm > 1 ? i % 2 : -1;
    const bg = `hsl(${hue(m.src)} 38% ${selM ? 36 : 28}%)`;
    mus.push(el("div", { class: "blk music" + (selM ? " sel" : "") + (S.tl.music?.locked ? " locked" : "") + (lane >= 0 ? " lane" + lane : ""),
      style: { left: from * pps + "px", width: Math.max(8, (to - from) * pps) + "px", cursor: "grab", background: bg },
      title: `Song ${i + 1}: ${songName(m.src)}  ${fmt(from)} → ${fmt(to)}. Drag to move it. Select it to replace the song, change where it ends, or press Split (S) to cut it at the playhead.`,
      onpointerdown: (e) => musicPointerDown(e, i) },
      el("div", { class: "lbl" }, `${i + 1} · ♫ ${songName(m.src)}`, el("span", { class: "tm" }, ` ${fmt(from)} → ${fmt(to)}` + (i === 0 && (m.shift || 0) ? `  (${m.shift > 0 ? "+" : ""}${m.shift.toFixed(1)}s)` : ""))),
      (m.fade_in ?? 0) > 0 && i > 0 ? el("div", { class: "fadein", style: { width: Math.min((to - from) * pps, (m.fade_in ?? 0) * pps) + "px" }, title: "fade in" }) : null,
      (m.fade_out ?? 2) > 0 && m.until != null ? el("div", { class: "fadeout", style: { width: Math.min((to - from) * pps, (m.fade_out ?? 2) * pps) + "px" }, title: "fade out" }) : null));
    if (i > 0) mus.push(el("div", { class: "songcut", style: { left: from * pps + "px" }, title: `Song ${i + 1} starts here: ${songName(m.src)}` }, el("span", {}, "▶ " + (i + 1))));
  }
  for (const b of (S.tl.beats || []).filter((b) => openerSeconds + b <= total + SLACK)) mus.push(el("div", { class: "beat", style: { left: (openerSeconds + b) * pps + "px" } }));
  $("#trackMusic").replaceChildren(...mus);
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
function clipPointerDown(e, id) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const handle = e.target.dataset?.h;
  if (e.shiftKey && S.sel?.t === "clip" && S.sel.id !== id) {   // shift-click: pick the range from the selected clip to this one
    const a = clipIndex(S.sel.id), b = clipIndex(id);
    S.multi = S.tl.clips.slice(Math.min(a, b), Math.max(a, b) + 1).map((c) => c.id);
    renderAll(); return;
  }
  S.multi = [];
  S.sel = { t: "clip", id };
  if (isLocked(findClip(id))) {                // locked: select + jump to it, but no drag / trim
    const it = lay().items.find((x) => x.clip.id === id); if (it) seek(it.start + 0.01);
    renderAll(); return;
  }
  const startX = e.clientX;
  const orig = clone(findClip(id));
  let moved = false, ghost = null;
  const pps = S.pps;
  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    if (!moved && Math.abs(dx) < 4) return;
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
      showDropMark(dropIndexAt(ev.clientX));
    }
  };
  const onUp = (ev) => {
    window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
    hideDropMark();
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
  S.multi = []; S.sel = { t: "group", id: gid }; renderAll(); toast("Grouped - type a name in the panel on the right");
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
  S.sel = { t: "group", id: gid }; S.multi = [];
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

function textPointerDown(e, id) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const handle = e.target.dataset?.h;
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
  S.sel = { t: "music", i };
  if (S.tl.music?.locked) { renderAll(); return; }
  const startX = e.clientX, m0 = musicAt(S.tl, i), orig = i === 0 ? (m0.shift || 0) : (m0.at || 0), len0 = m0.until != null ? m0.until - (i === 0 ? 0 : (m0.at || 0)) : null;
  let moved = false;
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
function splitAtPlayhead() {
  if (S.sel?.t === "music" && splitMusic()) return;
  const it = lay().items.find((x) => !x.isOpener && S.time > x.start + 0.15 && S.time < x.start + x.duration - 0.15);
  if (!it) { toast("Put the playhead inside a clip to split"); return; }
  const c = clone(it.clip), off = S.time - it.start;  // copy: commit() mutates the live clip
  const b = clone(c); b.id = newId(); b.transition = { type: "cut" }; delete b.text;
  commit((tl) => {
    const a = tl.clips.find((x) => x.id === c.id);
    if (a.kind === "image") { a.hold = r3(off); b.hold = r3((c.hold ?? 2.5) - off); }
    else { const t = r3(c.in + off * (c.speed || 1)); a.out = t; b.in = t; }
    tl.clips.splice(clipIndex(c.id) + 1, 0, b);
  });
  S.sel = { t: "clip", id: b.id }; renderAll(); toast("Split");
}
function deleteSelection() {
  if (!S.sel) return;
  const lockedSel = (S.sel.t === "clip" && isLocked(findClip(S.sel.id))) || (S.sel.t === "text" && S.tl.texts.find((t) => t.id === S.sel.id)?.locked) || (S.sel.t === "music" && S.tl.music?.locked) || (S.sel.t === "group" && groupOf(S.sel.id)?.locked);
  if (lockedSel) { toast("It's locked - release the lock first (L)"); return; }
  if (S.sel.t === "clip") commit((tl) => { tl.clips = tl.clips.filter((c) => c.id !== S.sel.id); });
  else if (S.sel.t === "text") commit((tl) => { tl.texts = (tl.texts || []).filter((t) => t.id !== S.sel.id); });
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
  commit((tl) => tl.clips.splice(clipIndex(id) + 1, 0, c));
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
      field("Clip sound", range(c.volume ?? 0, 0, 1, 0.05, (v) => setClip(c.id, "vol")((x) => { x.volume = v; })), `${Math.round((c.volume ?? 0) * 100)}%`),
      el("div", { class: "hint" }, "Music gets quieter automatically while a clip plays its own sound.")) : null,

    el("div", { class: "sec", id: "insp-trans" }, el("div", { class: "sec-t" }, "Transition in"),
      chips(TRANSITIONS, tr.type, (v) => upd((x) => { x.transition = { type: v, seconds: x.transition?.seconds || 0.35 }; })),
      tr.type !== "cut" ? field("Length", range(tr.seconds ?? 0.35, 0.1, 1.5, 0.05, (v) => setClip(c.id, "ts")((x) => { x.transition = { ...x.transition, seconds: v }; })), `${(tr.seconds ?? 0.35).toFixed(2)}s`) : null),

    el("div", { class: "sec" }, el("div", { class: "sec-t" }, "Look"),
      field("Motion", chips(MOTIONS, c.motion || "none", (v) => upd((x) => { x.motion = v; }))),
      field("Fit", chips(FITS, c.fit || "cover", (v) => upd((x) => { x.fit = v; }))),
      field("Rotate", el("div", { class: "btns" },
        el("button", { title: "Rotate 90° counter-clockwise", onclick: () => upd((x) => { x.rotate = (((x.rotate || 0) - 90) % 360 + 360) % 360; if (!x.rotate) delete x.rotate; }) }, "⟲ 90°"),
        el("button", { title: "Rotate 90° clockwise", onclick: () => upd((x) => { x.rotate = ((x.rotate || 0) + 90) % 360; if (!x.rotate) delete x.rotate; }) }, "⟳ 90°"),
        el("button", { title: "Flip upside down", onclick: () => upd((x) => { x.rotate = ((x.rotate || 0) + 180) % 360; if (!x.rotate) delete x.rotate; }) }, "↕ 180°")), `${c.rotate || 0}°`),
      field("Zoom in", range(c.zoom ?? 1, 1, 3, 0.05, (v) => setClip(c.id, "zoom")((x) => { if (v > 1) x.zoom = r3(v); else delete x.zoom; })), `${(c.zoom ?? 1).toFixed(2)}×`),
      el("div", { class: "row" },
        field("Focus ↔", range(c.focus?.x ?? 0.5, 0, 1, 0.01, (v) => setClip(c.id, "fx")((x) => { x.focus = { ...(x.focus || {}), x: v }; }))),
        field("Focus ↕", range(c.focus?.y ?? 0.5, 0, 1, 0.01, (v) => setClip(c.id, "fy")((x) => { x.focus = { ...(x.focus || {}), y: v }; }))))),

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
    field("Replace this song with…", select(songs.map((s) => s.src), m.src, (v) => commit((tl) => { musicAt(tl, i).src = v; if (i === 0) { tl.beats = []; S.songBeats = null; } }))),
    field("Ends at (s) — the music stops here and fades out", num(m.until ?? r3(sp.total), (v) => commit((tl) => { const mm = musicAt(tl, i); const t = r3(Math.max(sp.start + 1, v || 0)); if (t >= sp.total - 0.01) delete mm.until; else mm.until = t; }, `music${i}:until`))),
    i === 0
      ? field("Move music (s) — or drag it on the timeline", num(m.shift ?? 0, (v) => commit((tl) => { const mm = tl.music; mm.shift = r3(clamp(v || 0, -600, 600)); if (!mm.shift) delete mm.shift; if (tl.beats?.length) tl.beats = beatsFromSong(tl); }, "music:shift")), "− sooner · + later")
      : field("Starts at (s)", num(m.at ?? 0, (v) => commit((tl) => { const mm = musicAt(tl, i); const d = Math.max(0, v || 0) - (mm.at || 0); mm.at = r3(Math.max(0, v || 0)); if (mm.until != null) mm.until = r3(mm.until + d); }, `music${i}:at`))),
    field("Start the song at (s)", num(m.offset ?? 0, (v) => commit((tl) => { musicAt(tl, i).offset = r3(Math.max(0, v || 0)); if (i === 0 && tl.beats?.length) tl.beats = beatsFromSong(tl); }))),
    field("Volume", range(m.volume ?? 0.8, 0, 1, 0.05, (v) => upd("vol")((x) => { x.volume = v; })), `${Math.round((m.volume ?? 0.8) * 100)}%`),
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
  const { total } = lay();
  return el("div", { class: "insp" },
    el("h3", {}, "Video settings"),
    el("div", { class: "sub" }, `${tl.clips.length} clips · ${fmt(total)} · click a clip to edit it`),
    field("Title", el("input", { value: tl.title || "", onchange: (e) => commit((t) => { t.title = e.target.value; }) })),
    field("Format", chips(Object.keys(ASPECTS), aspect, (v) => commit((t) => { const [w, h] = ASPECTS[v]; t.format = { ...(t.format || {}), width: w, height: h }; }))),
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
function renderAll() {
  if (!S.tl) return;
  const selKey = JSON.stringify(S.sel);
  if (selKey !== lastSelKey) { lastSelKey = selKey; document.activeElement?.blur?.(); }
  $("#title").textContent = S.tl.title || ID;
  const [w, h] = [S.tl.format?.width ?? 1080, S.tl.format?.height ?? 1920];
  $("#player").style.aspectRatio = `${w}/${h}`;
  renderTimeline(); renderInspector(); renderSave(); renderBin(); renderComments();
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
  S.cm.open = on; $("#comments").classList.toggle("hidden", !on); $("#inspector").classList.toggle("hidden", on); $("#cmtBtn").classList.toggle("on", on);
  renderComments();
  if (on) setTimeout(() => $("#cmText")?.focus(), 0);
}
function cmAdd(text) {
  text = text.trim(); if (!text) return;
  const it = lay().items.find((x) => S.time >= x.start && S.time < x.start + x.duration);
  const c = { id: "n" + Math.random().toString(36).slice(2, 7), text, status: "open", created: cmStamp(), replies: [] };
  if (it) { c.clip = it.clip.id; c.offset = r3(S.time - it.start); if (it.clip.group) c.group = it.clip.group; } else c.at = r3(S.time);
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
  const it = lay().items.find((x) => S.time >= x.start && S.time < x.start + x.duration);
  const ta = el("textarea", { id: "cmText", placeholder: "What should change here?  (⌘/Ctrl+Enter to add)", dir: "auto",
    oninput: (e) => { S.cm.draft = e.target.value; }, onkeydown: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); cmAdd(ta.value); } } });
  ta.value = S.cm.draft;
  const list = by(S.cm.tab);
  box.replaceChildren(
    el("div", { class: "cm-head" }, el("h3", {}, "Review notes"), el("button", { class: "ghost", onclick: () => cmOpen(false) }, "✕")),
    el("div", { class: "cm-legend" }, ...[["new", "new"], ["todo", "you replied"], ["waiting", "Claude replied"], ["review", "fixed, approve?"], ["resolved", "resolved"]].map(([k, l]) => el("span", {}, el("i", { style: { background: `var(--st-${k})` } }), l))),
    el("div", { class: "cm-compose" }, el("div", { class: "where" }, `Pinned at ${fmt(S.time)}` + (it ? ` on ${it.clip.label || it.clip.id}` : "")), ta,
      el("div", { class: "row" }, el("button", { class: "primary", onclick: () => cmAdd(ta.value) }, "Add note"))),
    el("div", { class: "cm-tabs" }, ...tabs.map(([k, l]) => el("button", { class: (S.cm.tab === k ? "on " : "") + (k === "wait" && by(k).length ? "alert" : ""), onclick: () => { S.cm.tab = k; renderComments(); } }, l, el("span", { class: "dot" }, String(by(k).length))))),
    ...(list.length ? list.map(cmCard) : [el("div", { class: "cm-empty" }, S.cm.tab === "todo" ? "Nothing for Claude to do. Add notes as you watch." : S.cm.tab === "wait" ? "Nothing is waiting for you." : "No resolved notes.")]),
    ...(S.cm.tab === "resolved" && list.length ? [el("button", { class: "danger", onclick: () => cmChange((l) => { for (let i = l.length - 1; i >= 0; i--) if (l[i].status === "resolved") l.splice(i, 1); }) }, "Clear resolved")] : []));
  if (S.cm.flash) document.getElementById("cm-" + S.cm.flash)?.scrollIntoView({ block: "nearest" });
}

function bindKeys() {
  window.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (["input", "textarea", "select"].includes(tag)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
    if (e.key === " ") { e.preventDefault(); player?.toggle(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelection(); return; }
    if (e.key.toLowerCase() === "l" && S.sel && !mod) { toggleLock(S.sel.t, S.sel.id); return; }
    if (e.key.toLowerCase() === "c" && !mod) { e.preventDefault(); cmOpen(true); return; }
    if (e.key.toLowerCase() === "s") { splitAtPlayhead(); return; }
    if (e.key === "Escape") { S.sel = null; renderAll(); return; }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault(); const fps = S.tl.format?.fps ?? 30;
      seek(S.time + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 1 : 1 / fps));
    }
  });
}

function start() {
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
  $("#play").onclick = () => player?.toggle();
  $("#groupBtn").onclick = groupSelection;
  $("#cmtBtn").onclick = () => cmOpen(!S.cm.open);
  $("#fsBtn").onclick = () => { player?.fullscreen(); player?.play(); };
  $("#prevClip").onclick = () => jumpClip(-1); $("#nextClip").onclick = () => jumpClip(1);
  $("#splitBtn").onclick = splitAtPlayhead; $("#delBtn").onclick = deleteSelection; $("#addText").onclick = addText;
  $("#previewBtn").onclick = () => startRender(true); $("#exportBtn").onclick = () => startRender(false);
  $("#zoom").oninput = (e) => { S.pps = parseFloat(e.target.value); renderTimeline(); };
  for (const ev of ["wheel", "pointerdown", "touchstart"]) $("#tlScroll").addEventListener(ev, () => { S.userScrollAt = Date.now(); }, { passive: true });
  $("#play").addEventListener("click", () => { S.userScrollAt = 0; }); // pressing play follows the playhead again
  $("#ruler").addEventListener("pointerdown", rulerSeek);
  $("#tlInner").addEventListener("pointerdown", (e) => { if (e.target.classList.contains("track")) { S.sel = null; rulerSeek(e); renderAll(); } });
  $("#playhead .ph-knob").addEventListener("pointerdown", (e) => { e.stopPropagation(); rulerSeek(e); });
  window.addEventListener("resize", () => S.tl && renderTimeline());
  $("#inspector").addEventListener("focusout", () => setTimeout(() => S.tl && renderInspector(), 0));
  window.addEventListener("beforeunload", (e) => { if (S.dirty) { save(); e.preventDefault(); } });
  bindKeys();

  await loadMedia().catch(() => {});
  await loadTemplates().catch(() => {});
  loadSwitcher();
  const ok = await loadTimeline().catch((e) => { showEmpty(e.message); return false; });
  if (ok) start();
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
    clearTimeout(t); t = setTimeout(() => { refreshFromDisk(); loadMedia().catch(() => {}); }, 250);
  };
}
main();
