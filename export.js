// Turns a session into files: Word (.docx), plain text, Markdown, or a JSON backup.

import { parseBlocks, stripInline, inlineRuns } from './markdown.js';
import {
  stamp, speakerName, dateLine, fmtDuration, wordCount, typeLabel, fileBase, isoDate, spokenSegments,
} from './util.js';

export const FORMATS = {
  docx: { label: 'Word', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  txt: { label: 'Text', ext: 'txt', mime: 'text/plain' },
  md: { label: 'Markdown', ext: 'md', mime: 'text/markdown' },
  json: { label: 'Backup', ext: 'json', mime: 'application/json' },
};

const metaLine = (s) =>
  [typeLabel(s.type), dateLine(s.startedAt), fmtDuration(s.activeMs), `${wordCount(s).toLocaleString()} words`].join(' · ');

function lineParts(session, seg, opts) {
  return {
    stamp: opts.stamps ? stamp(session, seg, opts.stampMode) : '',
    speaker: opts.speakers ? speakerName(session, seg.speaker) : '',
    text: seg.text.trim(),
    starred: Boolean(seg.starred),
  };
}

const transcriptSegments = (session) =>
  session.segments.filter((s) => (s.kind === 'note' ? s.text : s.text.trim()));

export function plainText(session, opts) {
  const out = [session.title, metaLine(session), ''];
  if (opts.summary && session.summary?.text) {
    out.push('NOTES');
    for (const b of parseBlocks(session.summary.text)) {
      const t = stripInline(b.text);
      if (b.kind === 'heading') out.push('', t.toUpperCase());
      else if (b.kind === 'task') out.push(`${b.done ? '[x]' : '[ ]'} ${t}`);
      else if (b.kind === 'bullet') out.push(`• ${t}`);
      else if (b.kind === 'number') out.push(`${b.n}. ${t}`);
      else out.push(t);
    }
    out.push('', '', 'TRANSCRIPT', '');
  }
  for (const seg of transcriptSegments(session)) {
    if (seg.kind === 'note') {
      out.push(`[${seg.text}]`, '');
      continue;
    }
    const p = lineParts(session, seg, opts);
    const head = [p.stamp && `[${p.stamp}]`, p.speaker && `${p.speaker}:`].filter(Boolean).join(' ');
    out.push(`${p.starred ? '★ ' : ''}${head ? head + ' ' : ''}${p.text}`, '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function markdown(session, opts) {
  const out = [`# ${session.title}`, '', `_${metaLine(session)}_`, ''];
  if (opts.summary && session.summary?.text) {
    out.push('## Notes', '');
    // Demote the summary's own headings so they sit under "Notes".
    out.push(session.summary.text.replace(/^(#{1,3})\s/gm, (m, h) => `${'#'.repeat(Math.min(h.length + 1, 4))} `).trim(), '');
  }
  out.push('## Transcript', '');
  for (const seg of transcriptSegments(session)) {
    if (seg.kind === 'note') {
      out.push(`*[${seg.text}]*`, '');
      continue;
    }
    const p = lineParts(session, seg, opts);
    const head = [p.stamp && `[${p.stamp}]`, p.speaker && `${p.speaker}:`].filter(Boolean).join(' ');
    const text = p.starred ? `★ ${p.text}` : p.text;
    out.push(head ? `**${head}** ${text}` : text, '');
  }
  return out.join('\n').trim() + '\n';
}

export function backupJSON(sessions) {
  return JSON.stringify({ app: 'Verbatim', version: 1, exportedAt: new Date().toISOString(), sessions }, null, 2);
}

export function buildFile(session, format, opts) {
  const f = FORMATS[format];
  const name = `${fileBase(session.title, session.startedAt)}.${f.ext}`;
  let body;
  if (format === 'docx') body = docx(session, opts);
  else if (format === 'txt') body = plainText(session, opts);
  else if (format === 'md') body = markdown(session, opts);
  else body = backupJSON([session]);
  return new File([body], name, { type: f.mime });
}

export function buildBackupFile(sessions) {
  return new File([backupJSON(sessions)], `Verbatim backup ${isoDate(Date.now())}.json`, { type: FORMATS.json.mime });
}

// Read a backup made by buildBackupFile (or a single-session export).
export function parseBackup(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data?.sessions;
  if (!Array.isArray(list)) throw new Error('This file is not a Verbatim backup.');
  return list.filter((s) => s && typeof s.id === 'string' && Array.isArray(s.segments) && Array.isArray(s.speakers));
}

/* ---------- Word (.docx) ---------- */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

// Escape for XML and drop control characters that Word refuses to open.
const x = (s) => String(s ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function run(text, { bold, color, size, mono, highlight } = {}) {
  const props = [
    mono && '<w:rFonts w:ascii="Menlo" w:hAnsi="Menlo" w:cs="Menlo"/>',
    bold && '<w:b/>',
    color && `<w:color w:val="${color}"/>`,
    size && `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`,
    highlight && '<w:highlight w:val="yellow"/>',
  ].filter(Boolean).join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${x(text)}</w:t></w:r>`;
}

const TAB = '<w:r><w:tab/></w:r>';

const para = (runs, style) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs.join('')}</w:p>`;

const mdRuns = (text) => inlineRuns(text).map((r) => run(r.text, { bold: r.bold }));

function docx(session, opts) {
  const body = [
    para([run(session.title)], 'Title'),
    para([run(metaLine(session))], 'Meta'),
  ];
  const speakers = session.speakers.filter((sp) => spokenSegments(session).some((s) => s.speaker === sp.id));
  if (opts.speakers && speakers.length) body.push(para([run(`Speakers: ${speakers.map((s) => s.name).join(', ')}`)], 'Meta'));

  if (opts.summary && session.summary?.text) {
    body.push(para([run('Notes')], 'Heading1'));
    for (const b of parseBlocks(session.summary.text)) {
      if (b.kind === 'heading') body.push(para([run(stripInline(b.text))], 'Heading2'));
      else if (b.kind === 'task') body.push(para([run(b.done ? '☒' : '☐'), TAB, ...mdRuns(b.text)], 'ListItem'));
      else if (b.kind === 'bullet') body.push(para([run('•'), TAB, ...mdRuns(b.text)], 'ListItem'));
      else if (b.kind === 'number') body.push(para([run(`${b.n}.`), TAB, ...mdRuns(b.text)], 'ListItem'));
      else body.push(para(mdRuns(b.text)));
    }
  }

  body.push(para([run('Transcript')], 'Heading1'));
  for (const seg of transcriptSegments(session)) {
    if (seg.kind === 'note') {
      body.push(para([run(seg.text)], 'Note'));
      continue;
    }
    const p = lineParts(session, seg, opts);
    const runs = [];
    if (p.stamp) runs.push(run(`${p.stamp}   `, { mono: true, color: '6B7772', size: 18 }));
    if (p.speaker) runs.push(run(`${p.speaker}: `, { bold: true }));
    runs.push(run(p.text, { highlight: p.starred }));
    if (p.starred) runs.push(run(' ★', { color: 'B7791F' }));
    body.push(para(runs, 'Line'));
  }

  // US Letter for US English, A4 everywhere else.
  const letter = /^en-US/i.test(navigator.language || '');
  const pg = letter ? '<w:pgSz w:w="12240" w:h="15840"/>' : '<w:pgSz w:w="11906" w:h="16838"/>';
  const documentXml = `${XML_HEAD}<w:document xmlns:w="${W_NS}"><w:body>${body.join('')}<w:sectPr>${pg}<w:pgMar w:top="1440" w:right="1304" w:bottom="1440" w:left="1304" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const files = [
    ['[Content_Types].xml', `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`],
    ['_rels/.rels', `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`],
    ['docProps/core.xml', `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(session.title)}</dc:title><dc:creator>Verbatim</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date(session.startedAt).toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`],
    ['word/_rels/document.xml.rels', `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['word/styles.xml', STYLES_XML],
    ['word/document.xml', documentXml],
  ];
  const enc = new TextEncoder();
  return zipStore(files.map(([name, text]) => ({ name, data: enc.encode(text) })));
}

const STYLES_XML = `${XML_HEAD}<w:styles xmlns:w="${W_NS}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:eastAsia="Georgia" w:cs="Georgia"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/></w:pPr><w:rPr><w:rFonts w:ascii="Helvetica Neue" w:hAnsi="Helvetica Neue" w:cs="Arial"/><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Helvetica Neue" w:hAnsi="Helvetica Neue" w:cs="Arial"/><w:b/><w:color w:val="0E6B5E"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:ascii="Helvetica Neue" w:hAnsi="Helvetica Neue" w:cs="Arial"/><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Meta"><w:name w:val="Meta"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="40"/></w:pPr><w:rPr><w:rFonts w:ascii="Helvetica Neue" w:hAnsi="Helvetica Neue" w:cs="Arial"/><w:color w:val="5B6863"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListItem"><w:name w:val="List Item"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:ind w:left="360" w:hanging="360"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Line"><w:name w:val="Transcript Line"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="140"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Note"><w:name w:val="Transcript Note"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:color w:val="6B7772"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
</w:styles>`;

/* ---------- minimal ZIP writer (stored, no compression) ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipStore(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const { data } = f;
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, time, true);
    cen.setUint16(14, date, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: FORMATS.docx.mime });
}
