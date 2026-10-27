// A small Markdown renderer for Claude's summaries: headings, lists, task
// checkboxes, paragraphs and inline bold/italic/code. Input is escaped first.

import { esc } from './util.js';

const TASK = /^(\s*[-*]\s+)\[( |x|X)\]\s+/;

function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}

export function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let list = null; // 'ul' | 'ol'
  let para = [];

  const flushPara = () => {
    if (para.length) html.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };
  const openList = (kind) => {
    if (list !== kind) {
      closeList();
      html.push(`<${kind}>`);
      list = kind;
    }
  };

  lines.forEach((line, i) => {
    const t = line.trim();
    let m;
    if (!t) {
      flushPara();
      closeList();
    } else if ((m = t.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara();
      closeList();
      const level = Math.min(m[1].length + 1, 4);
      html.push(`<h${level}>${inline(m[2])}</h${level}>`);
    } else if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushPara();
      closeList();
      html.push('<hr>');
    } else if ((m = line.match(TASK))) {
      flushPara();
      openList('ul');
      const done = m[2].toLowerCase() === 'x';
      const rest = line.slice(m[0].length);
      html.push(`<li class="task${done ? ' done' : ''}"><label><input type="checkbox" data-line="${i}"${done ? ' checked' : ''}><span>${inline(rest)}</span></label></li>`);
    } else if ((m = t.match(/^[-*•]\s+(.*)$/))) {
      flushPara();
      openList('ul');
      html.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = t.match(/^\d+[.)]\s+(.*)$/))) {
      flushPara();
      openList('ol');
      html.push(`<li>${inline(m[1])}</li>`);
    } else {
      closeList();
      para.push(t);
    }
  });
  flushPara();
  closeList();
  return html.join('');
}

// Flip "- [ ]" <-> "- [x]" on one line of the source.
export function toggleTask(md, lineIndex) {
  const lines = String(md).split('\n');
  const line = lines[lineIndex];
  if (line == null) return md;
  lines[lineIndex] = line.replace(TASK, (all, lead, mark) => `${lead}[${mark === ' ' ? 'x' : ' '}] `);
  return lines.join('\n');
}

// Plain-text version for .txt exports and Word documents.
export function parseBlocks(md) {
  const blocks = [];
  for (const raw of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
    const t = raw.trim();
    let m;
    if (!t) continue;
    if ((m = t.match(/^#{1,4}\s+(.*)$/))) blocks.push({ kind: 'heading', text: m[1] });
    else if ((m = raw.match(TASK))) blocks.push({ kind: 'task', done: m[2].toLowerCase() === 'x', text: raw.slice(m[0].length) });
    else if ((m = t.match(/^[-*•]\s+(.*)$/))) blocks.push({ kind: 'bullet', text: m[1] });
    else if ((m = t.match(/^(\d+)[.)]\s+(.*)$/))) blocks.push({ kind: 'number', n: m[1], text: m[2] });
    else if (/^(-{3,}|\*{3,})$/.test(t)) continue;
    else blocks.push({ kind: 'para', text: t });
  }
  return blocks;
}

// "**Owner** — task" -> [{text:'Owner', bold:true}, {text:' — task'}]
export function inlineRuns(text) {
  const runs = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    runs.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.map((r) => ({ ...r, text: r.text.replace(/`([^`]+)`/g, '$1').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1$2') }));
}

export const stripInline = (text) => inlineRuns(text).map((r) => r.text).join('');
