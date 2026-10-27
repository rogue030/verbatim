// Formatting and session helpers shared by the UI, exports and summaries.

export const pad2 = (n) => String(n).padStart(2, '0');

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 754000 -> "12:34", 4354000 -> "1:12:34"
export function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

export function fmtDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'under 1 min';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return mins % 60 ? `${h} h ${mins % 60} min` : `${h} h`;
}

export function fmtTimeOfDay(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function dateLine(ts) {
  return new Date(ts).toLocaleString([], {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function stamp(session, seg, mode) {
  return mode === 'clock' ? fmtTimeOfDay(seg.at) : fmtElapsed(seg.at - session.startedAt);
}

export function speakerName(session, id) {
  return session.speakers.find((s) => s.id === id)?.name || 'Speaker';
}

export function speakerIndex(session, id) {
  return Math.max(0, session.speakers.findIndex((s) => s.id === id));
}

export const countWords = (text) => (text.match(/\S+/g) || []).length;

export function wordCount(session) {
  let n = 0;
  for (const seg of session.segments) if (seg.kind !== 'note') n += countWords(seg.text);
  return n;
}

export const spokenSegments = (session) => session.segments.filter((s) => s.kind !== 'note' && s.text.trim());

// Speaker names add noise to a one-person lecture, so only default them on when
// more than one speaker actually appears.
export function usesSeveralSpeakers(session) {
  return new Set(spokenSegments(session).map((s) => s.speaker)).size > 1;
}

// A readable file name: "Weekly product sync 2026-10-26". Characters that
// Files or Windows reject are removed; "1:28 PM" becomes "1.28 PM".
export function fileBase(title, ts) {
  const clean = String(title || '')
    .replace(/:/g, '.')
    .replace(/[/\\*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s*·\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Transcript';
  return `${clean} ${isoDate(ts)}`;
}

export function isoDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export const typeLabel = (type) => (type === 'lecture' ? 'Lecture' : 'Meeting');
