// Reads a word list from PDF, Word (.docx), Excel (.xlsx/.xls), CSV or text,
// and returns { words: [...], warnings: [...], fieldsFound: [...] }.
// Each word: { n, word, pronunciation, pos, definition, etymology, sentence, tip, extras }

import { loadScript } from './util.js';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';
const MAMMOTH = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';
const SHEETJS = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';

export const FIELDS = ['word', 'pronunciation', 'pos', 'definition', 'etymology', 'sentence', 'tip'];
export const FIELD_LABELS = {
  word: 'Word', pronunciation: 'Pronunciation', pos: 'Part of speech', definition: 'Meaning',
  etymology: 'Origin', sentence: 'Example sentence', tip: 'Memory tip',
};

// Column headings we recognise (lower-case, punctuation removed).
const HEADER_SYNONYMS = {
  num: ['#', 'no', 'num', 'number', 'sno', 'sr', 'srno', 'sl', 'slno', 'serial', 'id'],
  word: ['word', 'words', 'spelling', 'spelling word', 'term', 'vocabulary'],
  pronunciation: ['diacritic', 'diacritics', 'pronunciation', 'pronounce', 'phonetic', 'phonetics', 'ipa', 'sounds like'],
  pos: ['pos', 'part of speech', 'parts of speech', 'word class', 'type', 'grammar'],
  definition: ['definition', 'definitions', 'meaning', 'meanings', 'defn', 'def'],
  etymology: ['etymology', 'origin', 'origins', 'language of origin', 'language', 'root', 'roots', 'derivation', 'word origin'],
  sentence: ['example sentence', 'example sentences', 'sentence', 'example', 'examples', 'usage', 'use in a sentence', 'sentences'],
  tip: ['memory tip', 'memory tips', 'tip', 'tips', 'mnemonic', 'mnemonics', 'hint', 'hints', 'memory aid', 'trick'],
};

function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9# ]/g, '').replace(/\s+/g, ' ').trim();
}

function fieldForHeader(text) {
  const n = norm(text);
  if (!n) return null;
  for (const [field, syns] of Object.entries(HEADER_SYNONYMS)) if (syns.includes(n)) return field;
  for (const [field, syns] of Object.entries(HEADER_SYNONYMS)) if (field !== 'num' && syns.some(s => s.length > 3 && n.startsWith(s))) return field;
  return null;
}

function clean(s) {
  return String(s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

function finish(words, warnings, source) {
  const out = [];
  const seen = new Map();
  for (const w of words) {
    w.word = clean(w.word).replace(/^[\d.)\s]+(?=[A-Za-z])/, ''); // strip "12. " numbering
    if (!w.word || !/[A-Za-z]/.test(w.word)) continue;
    for (const f of FIELDS) w[f] = clean(w[f]);
    const key = w.word.toLowerCase();
    if (seen.has(key)) { warnings.push(`"${w.word}" appears more than once. Only the first was kept.`); continue; }
    seen.set(key, true);
    out.push(w);
  }
  out.forEach((w, i) => { if (!w.n) w.n = i + 1; });
  const fieldsFound = FIELDS.filter(f => out.some(w => w[f]));
  return { words: out, warnings, fieldsFound, source };
}

function blankWord(n = 0) {
  return { n, word: '', pronunciation: '', pos: '', definition: '', etymology: '', sentence: '', tip: '', extras: {} };
}

export async function importFile(file, onProgress = () => {}) {
  const name = file.name.toLowerCase();
  const ext = name.slice(name.lastIndexOf('.') + 1);
  if (ext === 'pdf') return importPdf(await file.arrayBuffer(), onProgress);
  if (ext === 'docx') return importDocx(await file.arrayBuffer());
  if (ext === 'doc') throw new Error('Old Word files (.doc) can\'t be read. Please open it in Word and "Save As" .docx, then upload that.');
  if (['xlsx', 'xls', 'xlsm', 'ods'].includes(ext)) return importSheet(await file.arrayBuffer());
  if (ext === 'csv' || ext === 'tsv') return importRows(parseDelimited(await file.text(), ext === 'tsv' ? '\t' : null), 'table');
  if (ext === 'txt' || ext === 'text' || ext === 'md' || file.type.startsWith('text/')) return importText(await file.text());
  throw new Error('That file type isn\'t supported. Please use PDF, Word (.docx), Excel, CSV or a text file.');
}

// ---------- Tables (CSV, Excel, Word tables) ----------

function findHeaderRow(rows) {
  for (let r = 0; r < Math.min(rows.length, 8); r++) {
    const fields = rows[r].map(fieldForHeader);
    const hits = fields.filter(f => f && f !== 'num');
    if (hits.includes('word') && hits.length >= 1 && (hits.length >= 2 || rows[r].filter(c => clean(c)).length <= 2)) return { r, fields };
    if (!hits.includes('word') && hits.length >= 2) {
      // Header without a "Word" column: assume the first unknown column is the word.
      const i = fields.findIndex(f => !f);
      if (i >= 0) { fields[i] = 'word'; return { r, fields }; }
    }
  }
  return null;
}

export function importRows(rows, kind = 'table') {
  const warnings = [];
  rows = rows.map(r => r.map(c => clean(c))).filter(r => r.some(c => c));
  if (!rows.length) throw new Error('The file looks empty.');
  let header = findHeaderRow(rows);
  let start;
  let fields;
  if (header) {
    start = header.r + 1; fields = header.fields;
  } else {
    // No headings: guess. Number column first if it is numeric, then word, then meaning.
    start = 0;
    const numericFirst = rows.slice(0, 10).every(r => /^\d+\.?$/.test(r[0] || ''));
    fields = numericFirst ? ['num', 'word', 'definition', 'sentence'] : ['word', 'definition', 'sentence'];
    if (rows[0].length > 1) warnings.push('No column headings were found, so the app guessed: ' + fields.filter(f => f !== 'num').map(f => FIELD_LABELS[f]).join(', ') + '. Please check a few words below.');
  }
  const headers = header ? rows[header.r] : [];
  const words = [];
  for (const row of rows.slice(start)) {
    const w = blankWord();
    row.forEach((cell, i) => {
      const f = fields[i];
      if (!cell) return;
      if (f === 'num') { if (/^\d+/.test(cell)) w.n = parseInt(cell, 10); }
      else if (f) w[f] = w[f] ? w[f] + ' ' + cell : cell;
      else if (headers[i]) w.extras[headers[i]] = cell;
    });
    words.push(w);
  }
  return finish(words, warnings, kind);
}

export function parseDelimited(text, delim) {
  text = text.replace(/^﻿/, '');
  if (!delim) {
    const first = text.split(/\r?\n/).slice(0, 5).join('\n');
    const counts = { ',': (first.match(/,/g) || []).length, '\t': (first.match(/\t/g) || []).length, ';': (first.match(/;/g) || []).length };
    delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function importSheet(buf) {
  await loadScript(SHEETJS);
  const wb = window.XLSX.read(buf, { type: 'array' });
  // Use the sheet with the most rows.
  let best = [];
  for (const name of wb.SheetNames) {
    const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
    if (rows.length > best.length) best = rows;
  }
  return importRows(best, 'spreadsheet');
}

// ---------- Plain text ----------

export function importText(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error('The file looks empty.');
  if (lines.filter(l => l.includes('\t')).length > lines.length / 2) return importRows(lines.map(l => l.split('\t')), 'text');

  const warnings = [];
  const words = [];
  const sep = /^(.+?)\s*(?:\s[-–—]\s|:\s|\s=\s)\s*(.+)$/;
  const withSep = lines.filter(l => sep.test(l)).length;
  if (withSep > lines.length / 2) {
    for (const l of lines) {
      const m = l.match(sep);
      const w = blankWord();
      if (m) { w.word = m[1]; w.definition = m[2]; } else w.word = l;
      words.push(w);
    }
    return finish(words, warnings, 'text');
  }
  // One word per line, or comma-separated words.
  let skipped = 0;
  for (const l of lines) {
    const parts = l.includes(',') ? l.split(',') : [l];
    for (const p of parts) {
      const t = p.trim().replace(/^\d+[.)]\s*/, '');
      if (/^[A-Za-z][A-Za-z'\- ]{0,40}$/.test(t) && t.split(' ').length <= 3) {
        const w = blankWord(); w.word = t; words.push(w);
      } else if (t) skipped++;
    }
  }
  if (skipped) warnings.push(`${skipped} line(s) didn't look like a single word and were skipped.`);
  return finish(words, warnings, 'text');
}

// ---------- Word (.docx) ----------

async function importDocx(buf) {
  await loadScript(MAMMOTH);
  const { value: html } = await window.mammoth.convertToHtml({ arrayBuffer: buf });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tables = [...doc.querySelectorAll('table')];
  if (tables.length) {
    const rows = [];
    for (const t of tables) for (const tr of t.querySelectorAll('tr')) rows.push([...tr.children].map(td => td.textContent));
    return importRows(rows, 'word');
  }
  const text = [...doc.body.children].map(el => el.textContent).join('\n');
  return importText(text);
}

// ---------- PDF ----------

async function importPdf(buf, onProgress) {
  const pdfjs = await import(PDFJS);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(tc.items
      .filter(t => t.str && t.str.trim())
      .map(t => ({ x: t.transform[4], y: Math.round(t.transform[5] * 10) / 10, w: t.width, s: t.str })));
    page.cleanup();
    onProgress(i / doc.numPages);
  }
  if (!pages.some(p => p.length)) throw new Error('No text could be found in this PDF. It may be a scanned image. Please try a Word, Excel or text version of the list.');

  const table = readPdfTable(pages);
  if (table) return table;
  // Not a table: treat as lines of text.
  const text = pages.map(p => groupLines(p).map(l => joinLine(l)).join('\n')).join('\n');
  return importText(text);
}

function groupLines(items) {
  const lines = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].y - it.y) < 2) last.push(it); else lines.push([it]);
  }
  for (const l of lines) l.sort((a, b) => a.x - b.x);
  return lines;
}

function joinLine(items) {
  let out = '';
  items.forEach((it, i) => {
    if (i) {
      const prev = items[i - 1];
      const gap = it.x - (prev.x + prev.w);
      if (gap > 1.5 && !/\s$/.test(out) && !/^\s/.test(it.s)) out += ' ';
    }
    out += it.s;
  });
  return out;
}

// Finds a header line (e.g. "# Word Diacritic POS Definition Etymology Example Sentence"),
// works out column positions from it, then groups text into rows.
function readPdfTable(pages) {
  let header = null;
  for (let p = 0; p < Math.min(pages.length, 3) && !header; p++) {
    for (const line of groupLines(pages[p])) {
      // Merge items that sit close together into header cells ("Example" + "Sentence").
      const cells = [];
      for (const it of line) {
        const last = cells[cells.length - 1];
        if (last && it.x - last.end < 6) { last.s += ' ' + it.s; last.end = it.x + it.w; }
        else cells.push({ x: it.x, end: it.x + it.w, s: it.s });
      }
      const mapped = cells.map(c => ({ ...c, f: fieldForHeader(c.s) })).filter(c => c.f);
      const named = mapped.filter(c => c.f !== 'num');
      if (named.some(c => c.f === 'word') && named.length >= 2) { header = mapped; break; }
    }
  }
  if (!header) return null;

  const cols = header.map(c => ({ f: c.f, x: c.x })).sort((a, b) => a.x - b.x);
  const colOf = x => {
    let f = cols[0].f;
    for (const c of cols) if (x >= c.x - 4) f = c.f;
    return f;
  };
  const anchorField = cols.some(c => c.f === 'num') ? 'num' : 'word';
  // A repeated heading row: most of its cells are exactly heading names.
  const headerTexts = new Set(header.map(c => norm(c.s)));
  const isHeaderLine = line => {
    const hits = line.filter(it => headerTexts.has(norm(it.s))).length;
    return hits >= Math.max(2, Math.ceil(header.length / 2));
  };

  // Prepare pages: items tagged with column, header lines removed, anchors found.
  const prepared = pages.map(items => {
    const body = [];
    for (const line of groupLines(items)) {
      if (isHeaderLine(line)) continue;
      for (const it of line) body.push({ ...it, c: colOf(it.x) });
    }
    const anchors = body
      .filter(it => it.c === anchorField && (anchorField !== 'num' || /^\d+\.?$/.test(it.s.trim())))
      .map(it => it.y)
      .filter((y, i, a) => a.indexOf(y) === i)
      .sort((a, b) => b - a);
    return { body, anchors };
  });

  // Are multi-line cells aligned to the bottom, top or middle of each row?
  let above = 0, below = 0;
  for (const { body, anchors } of prepared) {
    if (!anchors.length) continue;
    above += body.filter(it => it.y > anchors[0] + 1).length;
    below += body.filter(it => it.y < anchors[anchors.length - 1] - 1).length;
  }
  const align = below < above * 0.2 ? 'bottom' : above < below * 0.2 ? 'top' : 'middle';

  const rows = [];
  let carry = [];
  for (const { body, anchors } of prepared) {
    const pageRows = anchors.map(y => ({ y, items: [] }));
    const leftover = [];
    for (const it of body) {
      let row;
      if (align === 'bottom') row = pageRows.find(r => r.y <= it.y + 1);
      else if (align === 'top') row = [...pageRows].reverse().find(r => r.y >= it.y - 1);
      else row = pageRows.reduce((best, r) => (!best || Math.abs(r.y - it.y) < Math.abs(best.y - it.y) ? r : best), null);
      if (row) row.items.push(it); else leftover.push(it);
    }
    if (align === 'bottom') {
      // Text below the last row on a page continues on the next page's first row.
      if (carry.length && pageRows[0]) pageRows[0].items.push(...carry);
      carry = leftover;
    } else if (align === 'top') {
      // Text above the first row on a page belongs to the previous page's last row.
      if (rows.length) rows[rows.length - 1].items.push(...leftover);
    }
    rows.push(...pageRows);
  }

  const words = rows.map(r => {
    const w = blankWord();
    const byCol = {};
    for (const it of r.items) (byCol[it.c] ||= []).push(it);
    for (const [f, items] of Object.entries(byCol)) {
      const text = groupLines(items).map(joinLine).join(' ');
      if (f === 'num') w.n = parseInt(text, 10) || 0;
      else w[f] = text;
    }
    return w;
  });
  const warnings = [];
  if (align === 'middle') warnings.push('This table\'s layout was harder to read. Please spot-check a few words.');
  return finish(words, warnings, 'pdf');
}
