import { speechSupported, LiveRecognizer } from './engine.js';
import * as store from './store.js';
import { buildFile, buildBackupFile, plainText, parseBackup } from './export.js';
import { summarize, claudeAppPrompt } from './summary.js';
import { renderMarkdown, toggleTask } from './markdown.js';
import {
  uid, esc, fmtElapsed, fmtDuration, fmtTimeOfDay, stamp, speakerName, speakerIndex,
  wordCount, usesSeveralSpeakers, spokenSegments, typeLabel,
} from './util.js';

const $ = (sel) => document.querySelector(sel);

/* ---------- settings ---------- */

const LANGS = [
  ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-AU', 'English (Australia)'], ['en-CA', 'English (Canada)'],
  ['en-IN', 'English (India)'], ['en-IE', 'English (Ireland)'], ['en-NZ', 'English (New Zealand)'], ['en-ZA', 'English (South Africa)'],
  ['es-ES', 'Español (España)'], ['es-MX', 'Español (México)'], ['es-US', 'Español (Estados Unidos)'],
  ['fr-FR', 'Français (France)'], ['fr-CA', 'Français (Canada)'], ['de-DE', 'Deutsch'], ['de-CH', 'Deutsch (Schweiz)'],
  ['it-IT', 'Italiano'], ['pt-BR', 'Português (Brasil)'], ['pt-PT', 'Português (Portugal)'], ['nl-NL', 'Nederlands'],
  ['sv-SE', 'Svenska'], ['da-DK', 'Dansk'], ['nb-NO', 'Norsk bokmål'], ['fi-FI', 'Suomi'], ['pl-PL', 'Polski'],
  ['cs-CZ', 'Čeština'], ['ro-RO', 'Română'], ['hu-HU', 'Magyar'], ['el-GR', 'Ελληνικά'], ['tr-TR', 'Türkçe'],
  ['ru-RU', 'Русский'], ['uk-UA', 'Українська'], ['ar-SA', 'العربية'], ['he-IL', 'עברית'], ['hi-IN', 'हिन्दी'],
  ['th-TH', 'ไทย'], ['vi-VN', 'Tiếng Việt'], ['id-ID', 'Bahasa Indonesia'], ['ms-MY', 'Bahasa Melayu'],
  ['ja-JP', '日本語'], ['ko-KR', '한국어'], ['zh-CN', '中文（普通话）'], ['zh-TW', '中文（台灣）'], ['zh-HK', '粵語（香港）'],
];

const SETTINGS_KEY = 'verbatim.settings';
const API_KEY_KEY = 'verbatim.apiKey';
const SEEDED_KEY = 'verbatim.seeded';

function readLS(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function writeLS(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable */ }
}

function defaultLang() {
  const nav = navigator.language || 'en-US';
  return LANGS.find(([c]) => c.toLowerCase() === nav.toLowerCase())?.[0]
    || LANGS.find(([c]) => c.split('-')[0] === nav.split('-')[0])?.[0]
    || 'en-US';
}

const settings = { lang: defaultLang(), stampMode: 'elapsed', textSize: 18, keepAwake: true, ...readLS(SETTINGS_KEY, {}) };
const saveSettings = () => writeLS(SETTINGS_KEY, settings);
let apiKey = readLS(API_KEY_KEY, '');

/* ---------- state ---------- */

const state = {
  sessions: [],
  current: null, // session open in the session view
  tab: 'transcript',
  query: '',
  summarizing: null, // { id, text, controller }
  summaryError: null, // { id, message }
  storageWarned: false,
};

// The recording in progress, if any. It keeps running while you browse the library.
const live = {
  session: null,
  ctx: null, // per-recognizer bookkeeping: { session, slots, lastKey }
  rec: null,
  status: 'idle',
  paused: false,
  speakerId: null,
  intervalStart: 0,
  pausedAt: 0,
  hiddenAt: 0,
  hint: '',
  wake: null,
  wakeLock: null,
  timer: 0,
  reconnectTimer: 0,
};

const viewing = (s) => state.current === s && !$('#view-session').hidden;
const elapsedMs = () => (live.session ? live.session.activeMs + (live.paused ? 0 : Date.now() - live.intervalStart) : 0);
const gapText = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} sec` : fmtDuration(ms));
const fmtWhen = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/* ---------- toast & sheets ---------- */

let toastTimer = 0;
function toast(message, ms = 2800) {
  const t = $('#toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

let openSheetEl = null;
let onSheetClose = null;
function openSheet(selector, onClose) {
  closeSheet();
  openSheetEl = $(selector);
  onSheetClose = onClose || null;
  openSheetEl.hidden = false;
  $('#scrim').hidden = false;
}
function closeSheet() {
  if (!openSheetEl) return;
  openSheetEl.hidden = true;
  $('#scrim').hidden = true;
  const cb = onSheetClose;
  openSheetEl = null;
  onSheetClose = null;
  cb?.();
}

function confirmSheet({ title, body, ok = 'Delete', cancel = true, danger = true }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    $('#confirm-title').textContent = title;
    $('#confirm-body').textContent = body;
    const okBtn = $('#btn-confirm-ok');
    okBtn.textContent = ok;
    okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    $('#btn-confirm-cancel').hidden = !cancel;
    okBtn.onclick = () => { finish(true); closeSheet(); };
    $('#btn-confirm-cancel').onclick = () => closeSheet();
    openSheet('#sheet-confirm', () => finish(false));
  });
}
const infoSheet = (title, body) => confirmSheet({ title, body, ok: 'OK', cancel: false, danger: false });

function inputSheet({ title, value = '', placeholder = '', multiline = false, note = '', ok = 'Save' }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    $('#input-title').textContent = title;
    $('#input-note').textContent = note;
    $('#input-note').hidden = !note;
    const line = $('#input-line');
    const multi = $('#input-multi');
    const field = multiline ? multi : line;
    line.hidden = multiline;
    multi.hidden = !multiline;
    field.value = value;
    field.placeholder = placeholder;
    $('#btn-input-ok').textContent = ok;
    $('#btn-input-ok').onclick = () => { finish(field.value); closeSheet(); };
    $('#btn-input-cancel').onclick = () => closeSheet();
    line.onkeydown = (e) => { if (e.key === 'Enter') $('#btn-input-ok').click(); };
    openSheet('#sheet-input', () => finish(null));
    field.focus();
    if (!multiline) field.select();
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

/* ---------- saving ---------- */

const saveTimers = new Map();
function scheduleSave(s) {
  s.updatedAt = Date.now();
  clearTimeout(saveTimers.get(s.id));
  saveTimers.set(s.id, setTimeout(() => save(s), 1500));
}
async function save(s) {
  clearTimeout(saveTimers.get(s.id));
  saveTimers.delete(s.id);
  s.updatedAt = Date.now();
  try {
    await store.put(s);
  } catch {
    if (!state.storageWarned) {
      state.storageWarned = true;
      toast("Couldn't save to this iPhone's storage. Export the transcript before you close Verbatim.", 6000);
    }
  }
}
function flushSaves() {
  for (const id of [...saveTimers.keys()]) {
    const s = state.sessions.find((x) => x.id === id);
    if (s) save(s);
  }
}

/* ---------- library ---------- */

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const opts = { weekday: 'long', month: 'long', day: 'numeric' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
}

function searchHit(s, q) {
  if (s.title.toLowerCase().includes(q)) return { preview: null };
  const seg = s.segments.find((x) => x.text.toLowerCase().includes(q));
  if (seg) {
    const i = seg.text.toLowerCase().indexOf(q);
    const from = Math.max(0, i - 40);
    return { preview: `${from ? '…' : ''}${seg.text.slice(from, i + q.length + 80)}` };
  }
  if (s.summary?.text?.toLowerCase().includes(q)) return { preview: null };
  return null;
}

function renderLibrary() {
  const now = $('#now-recording');
  now.innerHTML = live.session
    ? `<button class="now-card" type="button" data-id="${esc(live.session.id)}"><span class="rec-dot${live.paused ? ' idle' : ''}"></span><span class="now-title">${live.paused ? 'Paused' : 'Recording'} · ${esc(live.session.title)}</span><span class="now-time" id="now-time">${fmtElapsed(elapsedMs())}</span></button>`
    : '';

  const q = state.query.trim().toLowerCase();
  const rows = [];
  for (const s of state.sessions) {
    if (s === live.session) continue;
    const hit = q ? searchHit(s, q) : { preview: null };
    if (hit) rows.push({ s, preview: hit.preview });
  }

  const list = $('#session-list');
  if (!rows.length) {
    list.innerHTML = q
      ? `<div class="list-empty">No recordings mention “${esc(state.query.trim())}”.</div>`
      : '<div class="list-empty">No recordings yet.<br>Tap <strong>Meeting</strong> or <strong>Lecture</strong> to start. Words appear as people talk.</div>';
    return;
  }

  let html = '';
  let lastDay = '';
  for (const { s, preview } of rows) {
    const day = dayLabel(s.startedAt);
    if (day !== lastDay) {
      html += `<h2 class="group-label">${esc(day)}</h2>`;
      lastDay = day;
    }
    const first = preview ?? spokenSegments(s)[0]?.text ?? 'No speech captured.';
    html += `<button class="sess" type="button" data-id="${esc(s.id)}">
      <span class="sess-top"><span class="sess-title">${esc(s.title)}</span>${s.sample ? '<span class="pill sample">Sample</span>' : ''}${s.summary?.text ? '<span class="pill done">Notes</span>' : ''}</span>
      <span class="sess-meta">${typeLabel(s.type)} · ${fmtTimeOfDay(s.startedAt)} · ${fmtDuration(s.activeMs)} · ${wordCount(s).toLocaleString()} words</span>
      <span class="sess-preview">${esc(first)}</span>
    </button>`;
  }
  list.innerHTML = html;
}

function renderSupportBanner() {
  const banner = $('#support-banner');
  const msg = supportProblem();
  banner.hidden = !msg;
  if (msg) banner.innerHTML = `<strong>${esc(msg.title)}</strong>${esc(msg.body)}`;
}

function supportProblem() {
  if (!window.isSecureContext) {
    return { title: 'Open Verbatim over https', body: 'Safari only allows the microphone on secure (https://) pages.' };
  }
  if (!speechSupported()) {
    if (navigator.standalone || matchMedia('(display-mode: standalone)').matches) {
      return { title: 'Recording needs Safari', body: "Live transcription isn't available in Home Screen apps on this iPhone. Open Verbatim in Safari to record. The Safari version keeps its own history." };
    }
    return { title: 'Speech recognition is not available in this browser', body: 'On iPhone, use Safari on iOS 14.5 or later with Dictation turned on. On a computer, use Chrome, Edge or Safari.' };
  }
  return null;
}

/* ---------- session view ---------- */

function showLibrary() {
  // Close sheets that belong to the session, but keep alerts and settings open.
  if (openSheetEl && !['sheet-confirm', 'sheet-settings'].includes(openSheetEl.id)) closeSheet();
  state.current = null;
  $('#view-session').hidden = true;
  $('#view-library').hidden = false;
  renderLibrary();
}

function openSession(s) {
  state.current = s;
  state.tab = 'transcript';
  $('#view-library').hidden = true;
  $('#view-session').hidden = false;
  renderSession();
  // Follow the live edge while recording; start past recordings from the top.
  if (live.session === s) scrollToEnd();
  else pane().scrollTop = 0;
  if (history.state?.view !== 'session') history.pushState({ view: 'session' }, '');
}

function renderSession() {
  const s = state.current;
  if (!s) return;
  const isLive = live.session === s;
  $('#session-title').textContent = s.title;
  $('#rec-strip').hidden = !isLive;
  $('#speaker-row').hidden = !isLive;
  $('#controls-live').hidden = !isLive;
  $('#controls-review').hidden = isLive;
  if (isLive) {
    renderSpeakerChips();
    renderRecStrip();
    renderPauseButton();
  }
  renderTabs();
  renderTranscript();
  renderSummary();
}

function renderTabs() {
  const s = state.current;
  $('#tab-transcript').setAttribute('aria-selected', String(state.tab === 'transcript'));
  $('#tab-summary').setAttribute('aria-selected', String(state.tab === 'summary'));
  $('#tab-summary').innerHTML = `Summary${s?.summary?.text ? '<span class="tab-dot"></span>' : ''}`;
  $('#pane-transcript').hidden = state.tab !== 'transcript';
  $('#pane-summary').hidden = state.tab !== 'summary';
  $('#jump-live').hidden = true;
}

/* ---------- transcript rendering ---------- */

const segEls = new Map();

function segEl(s, seg, prevSpeaker) {
  const li = document.createElement('li');
  li.dataset.id = seg.id;
  if (seg.kind === 'note') {
    li.className = 'note';
    li.innerHTML = `<span>${esc(seg.text)}</span>`;
    return li;
  }
  li.className = `seg spk-${(speakerIndex(s, seg.speaker) % 6) + 1}${seg.starred ? ' starred' : ''}${seg.live ? ' live' : ''}`;
  li.hidden = !seg.text;
  const name = seg.speaker !== prevSpeaker ? `<span class="seg-speaker">${esc(speakerName(s, seg.speaker))}</span>` : '';
  li.innerHTML = `<time class="seg-time">${esc(stamp(s, seg, settings.stampMode))}</time><div class="seg-body">${name}<p class="seg-text"><span class="seg-words"></span></p></div>`;
  li.querySelector('.seg-words').textContent = seg.text;
  return li;
}

function prevSpeakerBefore(s, seg) {
  const i = s.segments.indexOf(seg);
  for (let k = i - 1; k >= 0; k--) {
    const p = s.segments[k];
    if (p.kind === 'note') continue;
    if (p.text) return p.speaker;
  }
  return null;
}

function renderTranscript() {
  const s = state.current;
  const list = $('#transcript');
  list.textContent = '';
  segEls.clear();
  let prev = null;
  const frag = document.createDocumentFragment();
  for (const seg of s.segments) {
    const el = segEl(s, seg, prev);
    frag.append(el);
    segEls.set(seg.id, el);
    if (seg.kind !== 'note' && seg.text) prev = seg.speaker;
  }
  list.append(frag);
  renderEmptyTranscript();
}

function renderEmptyTranscript() {
  const s = state.current;
  const empty = !s.segments.some((x) => x.kind !== 'note' && x.text);
  const box = $('#empty-transcript');
  box.hidden = !empty;
  if (empty && live.session !== s) {
    box.querySelector('.empty-title').textContent = 'No speech was captured';
    box.querySelector('p:last-child').textContent = 'Tap Record more to try again.';
  } else if (empty) {
    box.querySelector('.empty-title').textContent = 'Listening for speech';
    box.querySelector('p:last-child').textContent = 'Words appear here as people talk. Tap a speaker below when someone else starts talking, and tap Mark to flag an important moment.';
  }
}

function rerenderSeg(seg) {
  const s = state.current;
  const el = segEls.get(seg.id);
  if (!el) return;
  const fresh = segEl(s, seg, prevSpeakerBefore(s, seg));
  el.replaceWith(fresh);
  segEls.set(seg.id, fresh);
}

function appendSegEl(seg) {
  const s = state.current;
  const stick = nearBottom();
  const el = segEl(s, seg, prevSpeakerBefore(s, seg));
  $('#transcript').append(el);
  segEls.set(seg.id, el);
  if (stick) scrollToEnd();
}

function updateSegEl(seg) {
  const el = segEls.get(seg.id);
  if (!el) return;
  if (seg.kind === 'note') return;
  const wasHidden = el.hidden;
  el.querySelector('.seg-words').textContent = seg.text;
  el.hidden = !seg.text;
  el.classList.toggle('live', Boolean(seg.live));
  el.classList.toggle('starred', Boolean(seg.starred));
  // A line that just became visible may need its speaker label.
  if (wasHidden && seg.text) rerenderSeg(seg);
}

const pane = () => $('#pane-transcript');
function nearBottom() {
  const p = pane();
  return p.scrollHeight - p.scrollTop - p.clientHeight < 140;
}
function scrollToEnd() {
  const p = pane();
  p.scrollTop = p.scrollHeight;
  $('#jump-live').hidden = true;
}

/* ---------- live transcription ---------- */

function newSegment(s, speaker) {
  const seg = { id: uid(), at: Date.now(), speaker, text: '', live: true };
  s.segments.push(seg);
  if (viewing(s)) appendSegEl(seg);
  return seg;
}

function addNote(s, text) {
  const seg = { id: uid(), kind: 'note', at: Date.now(), text };
  s.segments.push(seg);
  if (viewing(s)) appendSegEl(seg);
  scheduleSave(s);
}

// Positions inside a still-changing result are character offsets. Snap them
// forward to a word boundary so a word is never split between two lines.
function snapWord(text, pos) {
  if (pos <= 0) return 0;
  if (pos >= text.length) return text.length;
  if (/\s/.test(text[pos - 1])) return pos;
  const m = text.slice(pos).search(/\s/);
  return m === -1 ? text.length : pos + m;
}

function applySlot(s, slot) {
  const { text, pieces } = slot;
  const changed = [];
  pieces.forEach((p, k) => {
    if (p.seg.edited) return;
    const from = snapWord(text, p.from);
    const to = k + 1 < pieces.length ? snapWord(text, pieces[k + 1].from) : text.length;
    const t = text.slice(from, Math.max(from, to)).trim();
    const isLive = !slot.final && k === pieces.length - 1;
    if (p.seg.text !== t || Boolean(p.seg.live) !== isLive) {
      p.seg.text = t;
      p.seg.live = isLive;
      changed.push(p.seg);
    }
  });
  if (!changed.length || !viewing(s)) return;
  const stick = nearBottom();
  changed.forEach(updateSegEl);
  renderEmptyTranscript();
  if (stick) scrollToEnd();
  else if (live.session === s && state.tab === 'transcript') $('#jump-live').hidden = false;
}

function handleSlot(ctx, run, index, text, isFinal) {
  const s = ctx.session;
  const key = `${run}:${index}`;
  let slot = ctx.slots.get(key);
  if (!slot) {
    if (!text) return;
    slot = { text: '', final: false, pieces: [{ seg: newSegment(s, live.speakerId || s.speakers[0].id), from: 0 }] };
    ctx.slots.set(key, slot);
    ctx.lastKey = key;
  }
  slot.text = text;
  slot.final = isFinal;
  // Long monologues get a fresh line every ~45 seconds or ~480 characters,
  // so lectures carry regular timestamps.
  const last = slot.pieces[slot.pieces.length - 1];
  if (!isFinal && last.seg.text && (Date.now() - last.seg.at > 45000 || text.length - last.from > 480)) {
    slot.pieces.push({ seg: newSegment(s, last.seg.speaker), from: text.length });
  }
  applySlot(s, slot);
  scheduleSave(s);
}

function listen(s) {
  const ctx = { session: s, slots: new Map(), lastKey: null };
  live.ctx = ctx;
  live.status = 'starting';
  live.hint = '';
  live.rec = new LiveRecognizer({
    lang: s.lang || settings.lang,
    onSlot: (run, i, text, fin) => handleSlot(ctx, run, i, text, fin),
    onState: (st) => { if (live.ctx === ctx) handleRecState(st); },
    onError: (code, recoverable) => { if (live.ctx === ctx) handleRecError(code, recoverable); },
  });
  live.rec.start();
}

function startRecording(s) {
  live.session = s;
  live.paused = false;
  if (!s.speakers.some((sp) => sp.id === live.speakerId)) live.speakerId = s.speakers[0].id;
  const last = s.segments[s.segments.length - 1];
  if (last && Date.now() - last.at > 60000) addNote(s, `Resumed at ${fmtTimeOfDay(Date.now())}`);
  live.intervalStart = Date.now();
  s.recording = true;
  listen(s);
  acquireWakeLock();
  clearInterval(live.timer);
  live.timer = setInterval(tick, 1000);
}

function startNew(type) {
  if (live.session) {
    toast('Stop the current recording first.');
    openSession(live.session);
    return;
  }
  const problem = supportProblem();
  if (problem) {
    infoSheet(problem.title, problem.body);
    return;
  }
  const now = Date.now();
  const date = new Date(now).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const s = {
    id: uid(),
    v: 1,
    type,
    title: `${typeLabel(type)} · ${date}, ${fmtTimeOfDay(now)}`,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    activeMs: 0,
    lang: settings.lang,
    speakers: type === 'lecture'
      ? [{ id: 's1', name: 'Lecturer' }, { id: 's2', name: 'Audience' }]
      : [{ id: 's1', name: 'Speaker 1' }, { id: 's2', name: 'Speaker 2' }],
    segments: [],
    summary: null,
  };
  state.sessions.unshift(s);
  live.speakerId = 's1';
  // Start the recognizer inside the tap handler: iOS only shows the microphone
  // prompt in response to a direct user gesture.
  startRecording(s);
  openSession(s);
  save(s);
  store.persist();
}

function pauseRecording() {
  const s = live.session;
  if (!s || live.paused) return;
  live.rec.stop();
  live.paused = true;
  live.pausedAt = Date.now();
  s.activeMs += Date.now() - live.intervalStart;
  finalizeLive(s);
  renderRecStrip();
  renderPauseButton();
  scheduleSave(s);
}

function resumeRecording() {
  const s = live.session;
  if (!s || !live.paused) return;
  live.paused = false;
  live.intervalStart = Date.now();
  const gap = Date.now() - live.pausedAt;
  if (gap > 5000) addNote(s, `Paused for ${gapText(gap)}`);
  listen(s);
  acquireWakeLock();
  renderRecStrip();
  renderPauseButton();
}

function finalizeLive(s) {
  for (const seg of s.segments) {
    if (seg.live) {
      seg.live = false;
      if (viewing(s)) updateSegEl(seg);
    }
  }
}

function dropEmpty(s) {
  s.segments = s.segments.filter((seg) => seg.kind === 'note' || seg.text.trim() || seg.live);
  // Leading or trailing notes with no speech around them carry no information.
  while (s.segments.length && s.segments[s.segments.length - 1].kind === 'note') s.segments.pop();
}

function stopRecording() {
  const s = live.session;
  if (!s) return;
  live.rec?.stop();
  if (!live.paused) s.activeMs += Date.now() - live.intervalStart;
  live.session = null;
  live.paused = false;
  live.status = 'idle';
  clearInterval(live.timer);
  clearTimeout(live.reconnectTimer);
  releaseWakeLock();
  live.ctx = null;
  s.recording = false;
  finalizeLive(s);

  if (!spokenSegments(s).length && !s.summary) {
    deleteSession(s, { quiet: true });
    toast('Nothing was recorded, so the recording was discarded.');
    if (state.current === s) goLibrary();
    return;
  }
  // Safari can deliver the last words just after stop; tidy up once they land.
  setTimeout(() => {
    finalizeLive(s);
    dropEmpty(s);
    save(s);
    if (viewing(s)) renderSession();
    else if (!$('#view-library').hidden) renderLibrary();
  }, 1500);
  save(s);
  if (viewing(s)) renderSession();
  toast(`Saved · ${wordCount(s).toLocaleString()} words`);
}

function handleRecState(st) {
  clearTimeout(live.reconnectTimer);
  if (st === 'restarting') {
    // Restarts normally take a fraction of a second; only say so if it drags on.
    live.reconnectTimer = setTimeout(() => {
      live.status = 'reconnecting';
      renderRecStrip();
    }, 2500);
    return;
  }
  live.status = st;
  if (st === 'listening') live.hint = live.hint.startsWith('Apple') ? '' : live.hint;
  renderRecStrip();
}

function handleRecError(code, recoverable) {
  if (recoverable) {
    if (code === 'network') live.hint = "Apple's speech service can't be reached. Verbatim keeps retrying; check your connection.";
    renderRecStrip();
    return;
  }
  const s = live.session;
  const messages = {
    'not-allowed': ['Microphone access is off', 'Allow the microphone for this site: in Safari, tap aA › Website Settings › Microphone › Allow. Also check Settings › Apps › Safari › Microphone. Then start again.'],
    'service-not-allowed': ['Speech recognition is turned off', "Turn on Dictation in Settings › General › Keyboard › Enable Dictation. If you opened Verbatim from the Home Screen, open it in Safari instead."],
    'language-not-supported': ["This language isn't available", 'Speech recognition on this device does not support the selected language. Choose another one in Settings.'],
    'audio-capture': ["Can't use the microphone", 'Another app may be using it, for example a phone or FaceTime call. End the call and start again.'],
  };
  const [title, body] = messages[code] || ['Recording stopped', `The speech recognizer reported "${code}".`];
  if (s) stopRecording();
  infoSheet(title, body);
}

function renderRecStrip() {
  if (!live.session || !viewing(live.session)) return;
  const st = live.paused ? 'paused' : live.status;
  const labels = {
    starting: 'Starting…',
    listening: 'Listening',
    restarting: 'Listening',
    reconnecting: 'Reconnecting…',
    stalled: 'Microphone stopped',
    paused: 'Paused',
    stopped: 'Listening',
    idle: 'Stopped',
  };
  $('#rec-status').textContent = labels[st] || 'Listening';
  $('#rec-dot').classList.toggle('idle', st === 'paused' || st === 'stalled');
  $('#btn-resume-stalled').hidden = st !== 'stalled';
  let hint = live.hint;
  if (!hint && st === 'stalled') hint = 'iPhone stopped the microphone. Tap Tap to resume to keep going.';
  if (!hint && !live.paused && (live.wake === 'failed' || live.wake === 'unsupported')) {
    hint = 'The screen may lock and stop listening. For long sessions, set Settings › Display & Brightness › Auto-Lock to Never.';
  }
  $('#rec-hint').textContent = hint;
  $('#rec-hint').hidden = !hint;
  tick();
}

function renderPauseButton() {
  const b = $('#btn-pause');
  b.innerHTML = live.paused
    ? '<svg><use href="#i-play"/></svg><span>Resume</span>'
    : '<svg><use href="#i-pause"/></svg><span>Pause</span>';
}

function tick() {
  if (!live.session) return;
  const t = fmtElapsed(elapsedMs());
  if (viewing(live.session)) {
    $('#rec-timer').textContent = t;
    const w = wordCount(live.session);
    $('#rec-words').textContent = `${w.toLocaleString()} ${w === 1 ? 'word' : 'words'}`;
  }
  const nowTime = $('#now-time');
  if (nowTime) nowTime.textContent = t;
}

function renderSpeakerChips() {
  const s = live.session;
  if (!s) return;
  const row = $('#speaker-row');
  row.innerHTML = s.speakers.map((sp, i) =>
    `<button type="button" class="chip spk-${(i % 6) + 1}${sp.id === live.speakerId ? ' on' : ''}" data-speaker="${esc(sp.id)}" aria-pressed="${sp.id === live.speakerId}">${esc(sp.name)}</button>`).join('')
    + '<button type="button" class="chip add" data-speaker="+" aria-label="Add speaker"><svg><use href="#i-plus"/></svg></button>'
    + '<span class="chip-hint">Tap who’s talking</span>';
}

function setSpeaker(id) {
  const s = live.session;
  if (!s) return;
  if (id === live.speakerId) {
    openSpeakersSheet(s);
    return;
  }
  live.speakerId = id;
  const ctx = live.ctx;
  const slot = ctx?.slots.get(ctx.lastKey);
  if (slot && !slot.final) {
    const last = slot.pieces[slot.pieces.length - 1];
    if (slot.text.slice(last.from).trim() && last.seg.text) {
      // Words from here on belong to the new speaker.
      slot.pieces.push({ seg: newSegment(s, id), from: slot.text.length });
      applySlot(s, slot);
    } else {
      last.seg.speaker = id;
      if (viewing(s)) rerenderSeg(last.seg);
    }
  }
  renderSpeakerChips();
}

function addSpeaker(s) {
  const n = s.speakers.length + 1;
  const base = s.type === 'lecture' && n > 2 ? 'Student' : 'Speaker';
  const sp = { id: uid(), name: `${base} ${n}` };
  s.speakers.push(sp);
  scheduleSave(s);
  return sp;
}

function markMoment() {
  const s = live.session;
  if (!s) return;
  const seg = [...s.segments].reverse().find((x) => x.kind !== 'note' && x.text);
  if (!seg) {
    toast('Nothing to mark yet. Mark flags the line being spoken.');
    return;
  }
  seg.starred = !seg.starred;
  if (viewing(s)) rerenderSeg(seg);
  scheduleSave(s);
  const btn = $('#btn-mark');
  btn.classList.add('flash');
  setTimeout(() => btn.classList.remove('flash'), 600);
  toast(seg.starred ? `Marked the line at ${stamp(s, seg, settings.stampMode)} as important` : 'Mark removed');
}

/* ---------- screen wake lock ---------- */

async function acquireWakeLock() {
  if (!settings.keepAwake) {
    live.wake = 'off';
    return;
  }
  if (!('wakeLock' in navigator)) {
    live.wake = 'unsupported';
    renderRecStrip();
    return;
  }
  try {
    if (live.wakeLock && !live.wakeLock.released) return;
    live.wakeLock = await navigator.wakeLock.request('screen');
    live.wake = 'on';
  } catch {
    live.wake = 'failed';
  }
  renderRecStrip();
}

function releaseWakeLock() {
  live.wake = null;
  live.wakeLock?.release?.().catch(() => {});
  live.wakeLock = null;
}

/* ---------- summary ---------- */

function renderSummary() {
  const s = state.current;
  if (!s) return;
  const box = $('#summary-body');
  const job = state.summarizing?.id === s.id ? state.summarizing : null;
  const lecture = s.type === 'lecture';
  let html = '';

  if (job) {
    html += `<div class="sum-status"><span class="spinner"></span><span>${job.text ? 'Writing notes…' : 'Claude is reading the transcript…'}</span><span class="rec-spacer"></span><button class="btn btn-small" type="button" data-act="stop-summary">Stop</button></div>`;
    if (job.text) html += `<div class="md">${renderMarkdown(job.text)}</div>`;
    box.innerHTML = html;
    return;
  }

  if (state.summaryError?.id === s.id) html += `<p class="sum-error">${esc(state.summaryError.message)}</p>`;

  if (s.summary?.text) {
    const grown = wordCount(s) - (s.summary.words ?? wordCount(s));
    if (grown > 40) html += `<p class="sum-error">The transcript has grown by ${grown.toLocaleString()} words since these notes were written. Regenerate to include the new part.</p>`;
    html += `<div class="md">${renderMarkdown(s.summary.text)}</div>`;
    html += `<p class="sum-meta">${s.summary.source === 'pasted' ? 'Pasted from the Claude app' : 'Written by Claude'} · ${esc(fmtWhen(s.summary.at))}${s.summary.truncated ? ' · cut short' : ''}</p>`;
    html += `<div class="btn-row">
      <button class="btn" type="button" data-act="copy-summary"><svg><use href="#i-copy"/></svg>Copy</button>
      <button class="btn" type="button" data-act="${apiKey ? 'summarize' : 'copy-prompt'}"><svg><use href="#i-spark"/></svg>${apiKey ? 'Regenerate' : 'Copy new prompt'}</button>
      <button class="btn" type="button" data-act="paste-summary">Replace</button>
    </div>`;
    box.innerHTML = html;
    return;
  }

  html += `<div class="sum-card">
    <h3>${lecture ? 'Study notes' : 'Meeting notes'} from Claude</h3>
    <p>${lecture
      ? 'A summary, the main ideas, key terms with definitions, announced assignments and dates, and review questions.'
      : 'A summary, key points, decisions, and action items with owners and due dates.'}</p>
    ${apiKey
      ? '<button class="btn btn-primary" type="button" data-act="summarize"><svg><use href="#i-spark"/></svg>Summarize with Claude</button>'
      : '<button class="btn btn-primary" type="button" data-act="add-key">Add an API key to summarize here</button>'}
  </div>
  <div class="sum-card">
    <h3>Or use the Claude app</h3>
    <p>Copy a ready-made prompt that includes the whole transcript and paste it into a new chat. Then paste Claude’s answer back here so it’s saved and exported with the transcript.</p>
    <div class="btn-row">
      <button class="btn" type="button" data-act="copy-prompt"><svg><use href="#i-copy"/></svg>Copy prompt</button>
      <a class="btn" href="https://claude.ai/new" target="_blank" rel="noopener">Open Claude</a>
      <button class="btn" type="button" data-act="paste-summary">Paste notes</button>
    </div>
  </div>`;
  box.innerHTML = html;
}

async function runSummary(s) {
  if (!apiKey) {
    openSettings('api');
    return;
  }
  if (state.summarizing) {
    toast('Claude is already writing notes.');
    return;
  }
  if (wordCount(s) < 25) {
    toast('There isn’t enough transcript to summarize yet.');
    return;
  }
  const controller = new AbortController();
  state.summarizing = { id: s.id, text: '', controller };
  state.summaryError = null;
  if (state.current === s) {
    state.tab = 'summary';
    renderTabs();
    renderSummary();
  }
  let pending = false;
  try {
    const res = await summarize({
      apiKey,
      session: s,
      signal: controller.signal,
      onText: (text) => {
        if (!state.summarizing) return;
        state.summarizing.text = text;
        // Re-render at most once per frame while text streams in.
        if (!pending && state.current === s) {
          pending = true;
          requestAnimationFrame(() => { pending = false; if (state.summarizing) renderSummary(); });
        }
      },
    });
    s.summary = { text: res.text, model: res.model, at: Date.now(), source: 'claude', words: wordCount(s), truncated: res.truncated };
    await save(s);
    toast(res.truncated ? 'Notes saved, but they were cut short.' : 'Notes saved');
  } catch (err) {
    if (err.kind !== 'aborted') state.summaryError = { id: s.id, message: err.message };
  } finally {
    state.summarizing = null;
    if (state.current === s) {
      renderTabs();
      renderSummary();
    }
  }
}

async function pasteSummary(s) {
  const text = await inputSheet({
    title: 'Paste notes',
    note: 'Paste the notes Claude wrote. They’re saved with this recording and included in exports.',
    value: '',
    multiline: true,
    placeholder: '## Summary…',
  });
  if (!text?.trim()) return;
  s.summary = { text: text.trim(), at: Date.now(), source: 'pasted', words: wordCount(s) };
  state.summaryError = null;
  await save(s);
  renderTabs();
  renderSummary();
  toast('Notes saved');
}

/* ---------- export ---------- */

let exportFormat = 'docx';
const FORMAT_NOTES = {
  docx: 'Opens in Word, Pages and Google Docs.',
  txt: 'Plain text for Notes, Mail or anywhere else.',
  md: 'For Obsidian, Notion, Bear and other Markdown apps.',
  json: 'A complete copy of this recording that Verbatim can restore later.',
};

function openExport() {
  const s = state.current;
  const hasSummary = Boolean(s.summary?.text);
  $('#opt-summary').checked = hasSummary;
  $('#opt-summary').disabled = !hasSummary;
  $('#opt-summary').closest('.toggle-row').querySelector('span').textContent = hasSummary ? 'Summary and action items' : 'Summary (none yet)';
  $('#opt-stamps').checked = true;
  $('#opt-speakers').checked = usesSeveralSpeakers(s);
  setExportFormat(exportFormat);
  openSheet('#sheet-export');
}

function setExportFormat(f) {
  exportFormat = f;
  document.querySelectorAll('#export-format button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.format === f)));
  $('#export-format-note').textContent = FORMAT_NOTES[f];
  $('#export-options').hidden = f === 'json';
}

const exportOptions = () => ({
  summary: $('#opt-summary').checked,
  stamps: $('#opt-stamps').checked,
  speakers: $('#opt-speakers').checked,
  stampMode: settings.stampMode,
});

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// The iOS share sheet covers Save to Files, AirDrop, Mail, Notes and other apps.
async function shareFile(file) {
  const candidates = [file];
  if (file.type.startsWith('text/') && file.type !== 'text/plain') candidates.push(new File([file], file.name, { type: 'text/plain' }));
  const shareable = candidates.find((f) => navigator.canShare?.({ files: [f] }));
  if (shareable) {
    try {
      await navigator.share({ files: [shareable] });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
    }
  }
  downloadFile(file);
  return 'downloaded';
}

/* ---------- segment editing ---------- */

let editingSeg = null;
let editingSpeaker = null;

function openSegmentSheet(seg) {
  const s = state.current;
  editingSeg = seg;
  editingSpeaker = seg.speaker;
  $('#segment-stamp').textContent = stamp(s, seg, settings.stampMode);
  $('#segment-text').value = seg.text;
  $('#segment-star').checked = Boolean(seg.starred);
  renderSegmentSpeakers();
  openSheet('#sheet-segment', () => { editingSeg = null; });
}

function renderSegmentSpeakers() {
  const s = state.current;
  $('#segment-speakers').innerHTML = s.speakers.map((sp, i) =>
    `<button type="button" class="chip spk-${(i % 6) + 1}${sp.id === editingSpeaker ? ' on' : ''}" data-speaker="${esc(sp.id)}">${esc(sp.name)}</button>`).join('');
}

/* ---------- speakers ---------- */

let speakersFor = null;

function openSpeakersSheet(s) {
  speakersFor = s;
  renderSpeakerFields();
  openSheet('#sheet-speakers', () => {
    s.speakers.forEach((sp, i) => { if (!sp.name.trim()) sp.name = `Speaker ${i + 1}`; });
    speakersFor = null;
    save(s);
    if (live.session === s) renderSpeakerChips();
    if (viewing(s)) renderTranscript();
  });
}

function renderSpeakerFields() {
  const s = speakersFor;
  $('#speaker-fields').innerHTML = s.speakers.map((sp, i) =>
    `<div class="speaker-field spk-${(i % 6) + 1}"><span class="swatch"></span><input type="text" id="spk-${esc(sp.id)}" data-id="${esc(sp.id)}" value="${esc(sp.name)}" aria-label="Speaker ${i + 1} name" autocomplete="off"></div>`).join('');
}

/* ---------- settings ---------- */

function applyTextSize() {
  document.documentElement.style.setProperty('--text-size', `${settings.textSize}px`);
}

function renderKeyStatus() {
  $('#key-status').textContent = apiKey
    ? `A key ending in ${apiKey.slice(-4)} is saved on this device. Leave the field empty and tap Save to remove it.`
    : 'No key saved.';
}

async function openSettings(focus) {
  $('#set-lang').value = settings.lang;
  document.querySelectorAll('#set-stamps button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === settings.stampMode)));
  $('#set-size').value = settings.textSize;
  $('#set-awake').checked = settings.keepAwake;
  $('#set-key').value = '';
  renderKeyStatus();
  openSheet('#sheet-settings', () => {
    if (state.current) renderSession();
    else renderLibrary();
  });
  if (focus === 'api') {
    $('#field-api').scrollIntoView({ block: 'center' });
    $('#set-key').focus();
  }
  const est = await store.usage();
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const mb = est?.usage != null ? `${(est.usage / 1048576).toFixed(1)} MB` : 'an unknown amount';
  $('#storage-note').textContent = `${state.sessions.length} recordings using ${mb} on this device.${persisted ? '' : ' Safari may clear website data you haven’t opened in a while, so back up regularly.'}`;
}

/* ---------- FAQ ---------- */

let faqReturnFocus = null;

function openFaq() {
  faqReturnFocus = document.activeElement;
  $('#faq').hidden = false;
  $('#faq .overlay-body').scrollTop = 0;
  $('#btn-faq-done').focus();
}

function closeFaq() {
  $('#faq').hidden = true;
  faqReturnFocus?.focus?.();
  faqReturnFocus = null;
}

/* ---------- session actions ---------- */

async function deleteSession(s, { quiet = false } = {}) {
  if (live.session === s) stopRecording();
  state.sessions = state.sessions.filter((x) => x !== s);
  clearTimeout(saveTimers.get(s.id));
  saveTimers.delete(s.id);
  try { await store.remove(s.id); } catch { /* already gone */ }
  if (!quiet) toast('Recording deleted');
}

function goLibrary() {
  if (history.state?.view === 'session') history.back();
  else showLibrary();
}

async function renameSession(s) {
  const title = await inputSheet({ title: 'Rename recording', value: s.title });
  if (title == null || !title.trim()) return;
  s.title = title.trim();
  save(s);
  if (viewing(s)) $('#session-title').textContent = s.title;
}

/* ---------- sample ---------- */

function sampleSession() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(10, 0, 0, 0);
  const t0 = d.getTime();
  const lines = [
    [0, 's1', "Okay let's get started. Two things today, the launch date for the iOS update and the onboarding numbers from last week."],
    [14, 's2', 'So on onboarding, completion went from 61% to 68% after we cut the permissions screen. Most of the drop off now is at account creation.'],
    [41, 's1', "That's a good jump. Can we try sign in with Apple on that screen before launch, or is that too much?"],
    [55, 's2', "It's about three days of work. Priya said she could take it if we push the copy changes to the next sprint."],
    [78, 's1', "Let's do that. Sign in with Apple goes in and the copy changes move to next sprint.", true],
    [96, 's2', 'For the launch date, QA needs the build by Thursday. If that holds we can submit to App Store review on Friday and release on the 4th.'],
    [124, 's1', 'And if review takes longer than two days?'],
    [131, 's2', "Then we release on the 6th. Marketing's email can go out the same morning either way."],
    [150, 's1', "Fine. I'll tell marketing the window is the 4th to the 6th. Who's updating the release notes?"],
    [163, 's2', "I'll draft them by Wednesday and send them to you for review."],
    [176, 's1', "Great. One open question is whether we keep the old onboarding behind a flag for a week. Let's decide that on Monday. Thanks everyone."],
  ];
  const s = {
    id: 'sample-product-sync',
    v: 1,
    sample: true,
    type: 'meeting',
    title: 'Weekly product sync',
    createdAt: t0,
    updatedAt: t0,
    startedAt: t0,
    activeMs: 190000,
    lang: 'en-US',
    speakers: [{ id: 's1', name: 'Maya' }, { id: 's2', name: 'Jordan' }],
    segments: lines.map(([sec, speaker, text, starred], i) => ({ id: `sample-${i}`, at: t0 + sec * 1000, speaker, text, ...(starred ? { starred: true } : {}) })),
    summary: null,
  };
  s.summary = {
    source: 'claude',
    at: t0 + 300000,
    words: wordCount(s),
    text: `## Summary
The team reviewed onboarding results and set the launch window for the iOS update. Completion improved after the permissions screen was removed, so Sign in with Apple will be added before launch. The release is planned for the 4th, or the 6th if App Store review runs long.

## Key points
- Onboarding completion rose from 61% to 68% after the permissions screen was cut.
- Most remaining drop-off happens at account creation.
- QA needs the build by Thursday to submit for review on Friday.

## Decisions
- Add Sign in with Apple before launch and move the copy changes to next sprint.
- Release on the 4th, or on the 6th if review takes more than two days.

## Action items
- [ ] **Priya** — Build Sign in with Apple for the account creation screen.
- [ ] **Maya** — Tell marketing the release window is the 4th to the 6th.
- [ ] **Jordan** — Draft the release notes by Wednesday and send them to Maya.

## Open questions
- Should the old onboarding stay behind a flag for a week? To be decided on Monday.`,
  };
  return s;
}

/* ---------- events ---------- */

function bind() {
  $('#btn-new-meeting').addEventListener('click', () => startNew('meeting'));
  $('#btn-new-lecture').addEventListener('click', () => startNew('lecture'));
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#search').addEventListener('input', (e) => { state.query = e.target.value; renderLibrary(); });

  $('#session-list').addEventListener('click', (e) => {
    const card = e.target.closest('.sess');
    if (!card) return;
    const s = state.sessions.find((x) => x.id === card.dataset.id);
    if (s) openSession(s);
  });
  $('#now-recording').addEventListener('click', (e) => {
    if (e.target.closest('.now-card') && live.session) openSession(live.session);
  });

  $('#btn-back').addEventListener('click', goLibrary);
  window.addEventListener('popstate', (e) => {
    if (e.state?.view !== 'session') showLibrary();
  });
  $('#session-title').addEventListener('click', () => renameSession(state.current));
  $('#tab-transcript').addEventListener('click', () => { state.tab = 'transcript'; renderTabs(); scrollToEnd(); });
  $('#tab-summary').addEventListener('click', () => { state.tab = 'summary'; renderTabs(); renderSummary(); });

  $('#transcript').addEventListener('click', (e) => {
    const body = e.target.closest('.seg-body');
    if (!body) return;
    const s = state.current;
    const seg = s.segments.find((x) => x.id === body.parentElement.dataset.id);
    if (!seg) return;
    if (seg.live) {
      toast('This line is still being transcribed. You can edit it in a moment.');
      return;
    }
    openSegmentSheet(seg);
  });
  pane().addEventListener('scroll', () => { if (nearBottom()) $('#jump-live').hidden = true; }, { passive: true });
  $('#jump-live').addEventListener('click', scrollToEnd);

  // Live controls
  $('#speaker-row').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-speaker]');
    if (!chip || !live.session) return;
    if (chip.dataset.speaker === '+') {
      const sp = addSpeaker(live.session);
      setSpeaker(sp.id);
      toast(`Added ${sp.name}. Tap it again to rename.`);
    } else {
      setSpeaker(chip.dataset.speaker);
    }
  });
  $('#btn-mark').addEventListener('click', markMoment);
  $('#btn-pause').addEventListener('click', () => (live.paused ? resumeRecording() : pauseRecording()));
  $('#btn-stop').addEventListener('click', stopRecording);
  $('#btn-resume-stalled').addEventListener('click', () => {
    live.hint = '';
    live.rec?.kick();
  });

  // Review controls
  $('#btn-record-more').addEventListener('click', () => {
    const s = state.current;
    if (live.session) {
      toast('Stop the current recording first.');
      return;
    }
    const problem = supportProblem();
    if (problem) {
      infoSheet(problem.title, problem.body);
      return;
    }
    if (s.sample) {
      toast('This is a sample. Start a new meeting or lecture from the library.');
      return;
    }
    state.tab = 'transcript';
    startRecording(s);
    renderSession();
    scrollToEnd();
  });
  $('#btn-summarize').addEventListener('click', () => {
    const s = state.current;
    state.tab = 'summary';
    renderTabs();
    renderSummary();
    if (apiKey && !s.summary?.text) runSummary(s);
  });
  $('#btn-export').addEventListener('click', openExport);

  // Summary pane
  $('#summary-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const s = state.current;
    switch (btn.dataset.act) {
      case 'summarize': runSummary(s); break;
      case 'stop-summary': state.summarizing?.controller.abort(); break;
      case 'add-key': openSettings('api'); break;
      case 'paste-summary': pasteSummary(s); break;
      case 'copy-summary':
        toast((await copyText(s.summary.text)) ? 'Notes copied' : 'Couldn’t copy. Select the text and copy it instead.');
        break;
      case 'copy-prompt':
        toast((await copyText(claudeAppPrompt(s)))
          ? 'Prompt copied. Paste it into a new chat in the Claude app, then bring the answer back with Paste notes.'
          : 'Couldn’t copy the prompt.', 6000);
        break;
      default:
    }
  });
  $('#summary-body').addEventListener('change', (e) => {
    const box = e.target.closest('input[data-line]');
    const s = state.current;
    if (!box || !s.summary?.text) return;
    s.summary.text = toggleTask(s.summary.text, Number(box.dataset.line));
    box.closest('li').classList.toggle('done', box.checked);
    save(s);
  });

  // Export sheet
  $('#export-format').addEventListener('click', (e) => {
    const b = e.target.closest('[data-format]');
    if (b) setExportFormat(b.dataset.format);
  });
  $('#btn-do-share').addEventListener('click', async () => {
    const file = buildFile(state.current, exportFormat, exportOptions());
    const result = await shareFile(file);
    if (result === 'downloaded') toast(`Downloaded ${file.name}`);
    if (result !== 'cancelled') closeSheet();
  });
  $('#btn-do-download').addEventListener('click', () => {
    const file = buildFile(state.current, exportFormat, exportOptions());
    downloadFile(file);
    toast(`Downloaded ${file.name}`);
  });
  $('#btn-do-copy').addEventListener('click', async () => {
    const ok = await copyText(plainText(state.current, exportOptions()));
    toast(ok ? 'Transcript copied as text' : 'Couldn’t copy. Try Share instead.');
    if (ok) closeSheet();
  });

  // More menu
  $('#btn-more').addEventListener('click', () => {
    const s = state.current;
    $('#sheet-more [data-action="type"]').textContent = s.type === 'lecture' ? 'Change to meeting' : 'Change to lecture';
    openSheet('#sheet-more');
  });
  $('#sheet-more').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const s = state.current;
    closeSheet();
    switch (b.dataset.action) {
      case 'rename': renameSession(s); break;
      case 'speakers': openSpeakersSheet(s); break;
      case 'type':
        s.type = s.type === 'lecture' ? 'meeting' : 'lecture';
        save(s);
        renderSummary();
        toast(`Now a ${typeLabel(s.type).toLowerCase()}. Summaries will use the ${s.type === 'lecture' ? 'study notes' : 'meeting notes'} format.`);
        break;
      case 'export': openExport(); break;
      case 'delete':
        if (await confirmSheet({
          title: 'Delete this recording?',
          body: `“${s.title}” and its notes will be removed from this iPhone. This can’t be undone.`,
        })) {
          await deleteSession(s);
          goLibrary();
        }
        break;
      default:
    }
  });

  // Segment sheet
  $('#segment-speakers').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-speaker]');
    if (!chip) return;
    editingSpeaker = chip.dataset.speaker;
    renderSegmentSpeakers();
  });
  $('#btn-segment-save').addEventListener('click', () => {
    const s = state.current;
    const seg = editingSeg;
    if (!seg) return;
    const text = $('#segment-text').value.replace(/\s+/g, ' ').trim();
    if (!text) {
      $('#btn-segment-delete').click();
      return;
    }
    seg.text = text;
    seg.speaker = editingSpeaker;
    seg.starred = $('#segment-star').checked;
    seg.edited = true;
    closeSheet();
    renderTranscript();
    save(s);
  });
  $('#btn-segment-delete').addEventListener('click', () => {
    const s = state.current;
    const seg = editingSeg;
    if (!seg) return;
    seg.edited = true;
    s.segments = s.segments.filter((x) => x !== seg);
    closeSheet();
    renderTranscript();
    save(s);
    toast('Line deleted');
  });

  // Speakers sheet
  $('#speaker-fields').addEventListener('input', (e) => {
    const input = e.target.closest('input[data-id]');
    const sp = speakersFor?.speakers.find((x) => x.id === input?.dataset.id);
    if (sp) sp.name = input.value;
  });
  $('#btn-add-speaker').addEventListener('click', () => {
    if (!speakersFor) return;
    const sp = addSpeaker(speakersFor);
    renderSpeakerFields();
    const input = document.getElementById(`spk-${sp.id}`);
    input?.focus();
    input?.select();
  });

  // Settings
  $('#set-lang').innerHTML = LANGS.map(([code, name]) => `<option value="${code}">${esc(name)}</option>`).join('');
  $('#set-lang').addEventListener('change', (e) => { settings.lang = e.target.value; saveSettings(); });
  $('#set-stamps').addEventListener('click', (e) => {
    const b = e.target.closest('[data-value]');
    if (!b) return;
    settings.stampMode = b.dataset.value;
    saveSettings();
    document.querySelectorAll('#set-stamps button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  });
  $('#set-size').addEventListener('input', (e) => { settings.textSize = Number(e.target.value); applyTextSize(); saveSettings(); });
  $('#set-awake').addEventListener('change', (e) => {
    settings.keepAwake = e.target.checked;
    saveSettings();
    if (live.session) {
      if (settings.keepAwake) acquireWakeLock();
      else releaseWakeLock();
    }
  });
  $('#btn-save-key').addEventListener('click', () => {
    const value = $('#set-key').value.trim();
    if (!value) {
      if (apiKey) toast('API key removed');
      apiKey = '';
      writeLS(API_KEY_KEY, null);
    } else {
      if (!value.startsWith('sk-ant-')) toast('That doesn’t look like an Anthropic key (they start with sk-ant-). Saved anyway.', 4500);
      else toast('API key saved on this device');
      apiKey = value;
      writeLS(API_KEY_KEY, apiKey);
    }
    $('#set-key').value = '';
    renderKeyStatus();
  });
  $('#btn-backup').addEventListener('click', async () => {
    const real = state.sessions.filter((s) => !s.sample);
    if (!real.length) {
      toast('There are no recordings to back up yet.');
      return;
    }
    const result = await shareFile(buildBackupFile(real));
    if (result === 'downloaded') toast('Backup downloaded');
  });
  $('#restore-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const incoming = parseBackup(await file.text());
      let added = 0;
      for (const s of incoming) {
        const existing = state.sessions.find((x) => x.id === s.id);
        if (existing && (existing.updatedAt || 0) >= (s.updatedAt || 0)) continue;
        if (existing) state.sessions.splice(state.sessions.indexOf(existing), 1);
        s.segments.forEach((seg) => { seg.live = false; });
        s.recording = false;
        state.sessions.push(s);
        await store.put(s);
        added++;
      }
      state.sessions.sort((a, b) => b.startedAt - a.startedAt);
      toast(added ? `Restored ${added} ${added === 1 ? 'recording' : 'recordings'}` : 'Everything in that backup is already here.');
      renderLibrary();
    } catch (err) {
      toast(err instanceof SyntaxError ? 'That file isn’t a Verbatim backup.' : err.message, 4500);
    }
  });

  // Sheets close on the scrim or a Done/Cancel button.
  $('#scrim').addEventListener('click', closeSheet);
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheet));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#faq').hidden) closeFaq();
    else closeSheet();
  });

  // Startup disclaimer and FAQ
  $('#btn-agree').addEventListener('click', () => {
    $('#disclaimer').hidden = true;
    $('#app').inert = false;
  });
  document.querySelectorAll('[data-open-faq]').forEach((b) => b.addEventListener('click', openFaq));
  $('#btn-faq-done').addEventListener('click', closeFaq);

  // iOS stops listening in the background; note the gap and pick up again.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (live.session && !live.paused) live.hiddenAt = Date.now();
      flushSaves();
      return;
    }
    if (live.session && !live.paused) {
      const gap = live.hiddenAt ? Date.now() - live.hiddenAt : 0;
      live.hiddenAt = 0;
      if (gap > 4000) addNote(live.session, `Not recording for ${gapText(gap)} while Verbatim was in the background`);
      if (!live.rec.running) live.rec.kick();
      acquireWakeLock();
    }
  });
  window.addEventListener('pagehide', flushSaves);
}

/* ---------- start ---------- */

async function init() {
  applyTextSize();
  bind();
  $('#btn-agree').focus();
  renderSupportBanner();
  try {
    state.sessions = await store.all();
  } catch {
    state.sessions = [];
    toast("This browser won't let Verbatim save recordings. Export each one before you close the page.", 6000);
  }
  for (const s of state.sessions) {
    // A recording that was cut off (app closed, phone restarted) is kept as is.
    if (s.recording || s.segments.some((seg) => seg.live)) {
      s.recording = false;
      s.segments.forEach((seg) => { seg.live = false; });
      save(s);
    }
  }
  if (!readLS(SEEDED_KEY, false)) {
    writeLS(SEEDED_KEY, true);
    if (!state.sessions.length) {
      const sample = sampleSession();
      state.sessions.push(sample);
      store.put(sample).catch(() => {});
    }
  }
  state.sessions.sort((a, b) => b.startedAt - a.startedAt);
  if (history.state?.view === 'session') history.replaceState(null, '');
  renderLibrary();

  if ('serviceWorker' in navigator && window.isSecureContext && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
