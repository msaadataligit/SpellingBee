// Fills gaps in a word's information from free online dictionaries (no keys needed).
// Only the word itself is sent. Results are cached on this device.

import * as db from './db.js';

export const SOURCES = {
  freedict: { name: 'Free Dictionary', url: w => `https://dictionaryapi.dev/` },
  wiktionary: { name: 'Wiktionary', url: w => `https://en.wiktionary.org/wiki/${encodeURIComponent(w)}` },
};

const CACHE_DAYS = 60;
const inflight = new Map();

async function fetchJson(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function freeDictionary(word) {
  const j = await fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
  if (!Array.isArray(j) || !j.length) return {};
  const meanings = j.flatMap(entry => entry.meanings || []);
  const first = meanings[0];
  const out = {};
  if (first?.definitions?.[0]?.definition) out.definition = first.definitions[0].definition;
  if (first?.partOfSpeech) out.pos = first.partOfSpeech;
  for (const m of meanings) {
    const d = (m.definitions || []).find(d => d.example);
    if (d) { out.sentence = d.example; break; }
  }
  return out;
}

// Pulls the English Etymology section and the hyphenation from a Wiktionary page.
async function wiktionary(word) {
  const j = await fetchJson(`https://en.wiktionary.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&origin=*&titles=${encodeURIComponent(word)}`);
  const page = j && Object.values(j.query?.pages || {})[0];
  const text = page?.extract;
  if (!text) return {};
  const english = (text.split(/\n== English ==\n/)[1] || '').split(/\n== [^=]/)[0];
  if (!english) return {};
  const out = {};
  const ety = english.match(/=== Etymology(?: \d+)? ===\n+([\s\S]*?)(?=\n=|$)/);
  if (ety) {
    const t = ety[1].replace(/‎/g, '').replace(/\s*\n+\s*/g, ' ').trim();
    if (t && !/^\(?This etymology is missing/i.test(t)) {
      // Keep the main chain only: first sentence, cut at "ultimately" asides, max ~300 characters.
      let s = t.split(/(?<=[a-z\)”"])\.\s+(?=[A-Z])/)[0].split(/;\s*ultimately\b/)[0];
      if (s.length > 300) s = s.slice(0, 297).replace(/\s\S*$/, '') + '…';
      out.etymology = /[.…]$/.test(s) ? s : s + '.';
    }
  }
  const hy = english.match(/Hyphenation: ([^\n]+)/);
  if (hy) out.syllables = hy[1].split(/[,;]/)[0].replace(/‧/g, '·').trim();
  return out;
}

// Makes an example sentence bee-style, with the word blanked out.
function blankOut(sentence, word) {
  const re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
  return re.test(sentence) ? sentence.replace(re, '_____') : sentence;
}

// Returns { fields: { definition, pos, sentence, etymology, syllables }, sources: { field: sourceKey }, error }
export async function lookupWord(word) {
  const key = 'lookup:' + word.toLowerCase();
  const cached = await db.getKV(key);
  if (cached && Date.now() - cached.at < CACHE_DAYS * 864e5) return cached.result;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const result = { fields: {}, sources: {} };
    const [fd, wk] = await Promise.allSettled([freeDictionary(word), wiktionary(word)]);
    const add = (settled, src) => {
      if (settled.status !== 'fulfilled') return;
      for (const [f, v] of Object.entries(settled.value)) {
        if (v && !result.fields[f]) { result.fields[f] = f === 'sentence' ? blankOut(v, word) : v; result.sources[f] = src; }
      }
    };
    add(fd, 'freedict');
    add(wk, 'wiktionary');
    if (fd.status === 'rejected' && wk.status === 'rejected') {
      result.error = navigator.onLine === false ? 'offline' : 'failed';
      return result; // don't cache failures
    }
    await db.setKV(key, { at: Date.now(), result });
    return result;
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

const GAP_FIELDS = ['definition', 'pos', 'sentence', 'etymology'];

export function hasGaps(w) {
  return GAP_FIELDS.some(f => !w[f]);
}

// Returns a copy of the word with missing fields filled in, plus .webSources = { field: sourceKey }.
export async function fillGaps(w) {
  if (!hasGaps(w) && w.syllables) return w;
  const r = await lookupWord(w.word);
  const out = { ...w, webSources: {} };
  for (const f of GAP_FIELDS) {
    if (!out[f] && r.fields[f]) { out[f] = r.fields[f]; out.webSources[f] = r.sources[f]; }
  }
  if (r.fields.syllables) out.syllables = r.fields.syllables;
  out.lookupError = r.error;
  return out;
}

export function sourceLabel(src, word) {
  const s = SOURCES[src];
  if (!s) return '';
  return `<span class="source web">🌐 From <a href="${s.url(word)}" target="_blank" rel="noopener noreferrer">${s.name}</a></span>`;
}
