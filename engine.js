// Wraps the browser's speech recognizer (Apple's dictation service in Safari) and
// keeps it listening for as long as a meeting or lecture runs.
//
// Safari ends recognition on silence, after about a minute, and whenever the page
// is backgrounded, so the wrapper restarts it automatically. If restarts keep
// failing (iOS sometimes requires a fresh tap), it reports "stalled" so the UI
// can offer a resume button.

const Impl = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

export const speechSupported = () => Boolean(Impl);

// Errors that restarting will not fix.
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture']);

let runCounter = 0;

export class LiveRecognizer {
  /**
   * @param {object} o
   * @param {string} o.lang BCP-47 language tag
   * @param {(run:number, index:number, text:string, isFinal:boolean) => void} o.onSlot
   * @param {(state:'listening'|'restarting'|'stalled'|'stopped') => void} o.onState
   * @param {(code:string, recoverable:boolean) => void} o.onError
   */
  constructor({ lang, onSlot, onState, onError }) {
    Object.assign(this, { lang, onSlot, onState, onError });
    this.wanted = false;
    this.running = false;
    this.quickFails = 0;
    this.timer = 0;
    this.watchdog = 0;
    this.rec = null;
  }

  start() {
    this.wanted = true;
    this.quickFails = 0;
    this._open();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.timer);
    clearTimeout(this.watchdog);
    if (this.rec && this.running) {
      try { this.rec.stop(); } catch { /* already stopped */ }
    }
    this.onState('stopped');
  }

  // Restart right away, e.g. after the app returns from the background or the
  // user taps "Tap to resume" (a tap also satisfies iOS's gesture requirement).
  kick() {
    if (!this.wanted) return;
    this.quickFails = 0;
    clearTimeout(this.timer);
    if (this.running) {
      try { this.rec.abort(); } catch { /* onend will restart */ }
    } else {
      this._open();
    }
  }

  _ensure() {
    if (this.rec) return this.rec;
    const r = new Impl();
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onstart = () => {
      clearTimeout(this.watchdog);
      this.running = true;
      this.startedAt = Date.now();
      this.gotResult = false;
      this.onState('listening');
    };
    r.onresult = (e) => this._results(e);
    r.onerror = (e) => this._error(e.error);
    r.onend = () => this._ended();
    this.rec = r;
    return r;
  }

  _open() {
    const r = this._ensure();
    r.lang = this.lang;
    this.run = ++runCounter;
    this.startedAt = Date.now();
    this.gotResult = false;
    clearTimeout(this.watchdog);
    // If the engine never confirms it started, treat it like a failed run.
    this.watchdog = setTimeout(() => {
      if (!this.running && this.wanted) this._ended();
    }, 4000);
    try {
      r.start();
    } catch (err) {
      if (err?.name !== 'InvalidStateError') {
        clearTimeout(this.watchdog);
        this._ended();
      }
    }
  }

  _results(e) {
    this.gotResult = true;
    this.quickFails = 0;
    const raws = [];
    for (let i = 0; i < e.results.length; i++) raws.push(e.results[i][0]?.transcript ?? '');
    const texts = dedupe(raws);
    for (let i = 0; i < texts.length; i++) this.onSlot(this.run, i, texts[i], e.results[i].isFinal);
  }

  _error(code) {
    // "no-speech" and "aborted" just end the run; onend restarts it.
    if (code === 'no-speech' || code === 'aborted') return;
    if (FATAL.has(code)) {
      this.wanted = false;
      this.onError(code, false);
      return;
    }
    this.onError(code, true);
  }

  _ended() {
    clearTimeout(this.watchdog);
    this.running = false;
    if (!this.wanted) {
      this.onState('stopped');
      return;
    }
    const lived = Date.now() - (this.startedAt || 0);
    if (!this.gotResult && lived < 2000) this.quickFails++;
    else this.quickFails = 0;
    if (this.quickFails >= 6) {
      this.onState('stalled');
      return;
    }
    this.onState('restarting');
    const delay = this.quickFails ? Math.min(250 * 2 ** this.quickFails, 4000) : 100;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.wanted && this._open(), delay);
  }
}

// Some iOS versions return each result with every earlier result repeated in
// front of it ("hello", "hello there", "hello there everyone"). Strip a repeated
// prefix so the transcript doesn't stutter. Independent phrases pass through.
const normWord = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

export function dedupe(raws) {
  const out = [];
  let prev = '';
  let prevTokens = [];
  for (const raw of raws) {
    const text = raw.trim();
    const tokens = text.split(/\s+/).filter(Boolean);
    let eff = text;
    if (prev && text.startsWith(prev)) {
      eff = text.slice(prev.length).trim();
    } else if (prevTokens.length && tokens.length >= prevTokens.length &&
      prevTokens.every((t, k) => normWord(t) === normWord(tokens[k]))) {
      eff = tokens.slice(prevTokens.length).join(' ');
    }
    out.push(eff);
    prev = text;
    prevTokens = tokens;
  }
  return out;
}
