// Memory tips the app works out by itself from the spelling (and from her past mistakes).
// Each tip is { html, kind } where kind is 'personal' | 'pattern' | 'chunks'.

import { escapeHtml as e } from './util.js';
import { alignSpelling } from './progress.js';

const VOWELS = 'aeiouy';
const DIGRAPHS = ['ch', 'sh', 'th', 'ph', 'gh', 'wh', 'ck', 'qu', 'ng', 'rh'];

// Rough written syllable chunks, e.g. accommodate -> ac·com·mo·date
export function chunk(word) {
  const w = word.toLowerCase();
  if (!/^[a-z]+$/.test(w) || w.length < 6) return null;
  const isV = (i) => VOWELS.includes(w[i]) && !(w[i] === 'y' && i === 0) && !(w[i] === 'u' && w[i - 1] === 'q');
  const parts = [];
  let start = 0;
  let i = 0;
  while (i < w.length) {
    // find a vowel group
    while (i < w.length && !isV(i)) i++;
    while (i < w.length && isV(i)) i++;
    const cStart = i;
    while (i < w.length && !isV(i)) i++;
    if (i >= w.length) break; // last syllable takes the rest
    const cons = w.slice(cStart, i);
    let cut;
    if (cons.length === 0) cut = cStart;
    else if (cons.length === 1) cut = cStart;                      // ba·by
    else if (DIGRAPHS.includes(cons.slice(-2)) && cons.length === 2) cut = cStart; // mo·ther
    else if (/^(bl|br|cl|cr|dr|fl|fr|gl|gr|pl|pr|tr)$/.test(cons)) cut = cStart;    // pro·cras
    else if (/^(bl|br|cl|cr|dr|fl|fr|gl|gr|pl|pr|sc|sk|sl|sm|sn|sp|st|sw|tr|tw)$/.test(cons.slice(-2)) && cons.length >= 3) cut = i - 2;
    else cut = cStart + 1;                                         // ac·com
    // keep a lone final "e" with the previous chunk (date, not da·te)
    if (w.slice(cut) === 'e' || /^[^aeiouy]*e$/.test(w.slice(cut)) && w.slice(cut).length <= 2) break;
    parts.push(w.slice(start, cut));
    start = cut;
    i = cut;
  }
  parts.push(w.slice(start));
  return parts.length >= 3 ? parts.join('·') : null;
}

const ENDINGS = [
  [/ible$/, 'Ends in <b>-ible</b> (not -able).'],
  [/able$/, 'Ends in <b>-able</b> (not -ible).'],
  [/ance$/, 'Ends in <b>-ance</b> (not -ence).'],
  [/ence$/, 'Ends in <b>-ence</b> (not -ance).'],
  [/ant$/, 'Ends in <b>-ant</b> (not -ent).'],
  [/ent$/, 'Ends in <b>-ent</b> (not -ant).'],
  [/ary$/, 'Ends in <b>-ary</b> (not -ery).'],
  [/ery$/, 'Ends in <b>-ery</b> (not -ary).'],
  [/sede$/, 'Ends in <b>-sede</b>, the only common English word ending like this is “supersede”.'],
  [/ceed$/, 'Ends in <b>-ceed</b> (like exceed, proceed, succeed).'],
  [/cede$/, 'Ends in <b>-cede</b> (not -ceed).'],
  [/cian$/, 'Ends in <b>-cian</b>: used for people (musician, magician).'],
  [/sion$/, 'Ends in <b>-sion</b> (not -tion).'],
  [/eous$/, 'Ends in <b>-eous</b>. Don’t forget the e.'],
  [/ious$/, 'Ends in <b>-ious</b>. Don’t forget the i.'],
  [/ous$/, 'Ends in <b>-ous</b>.'],
];

function patternTips(word, pron = '') {
  const w = word.toLowerCase();
  const tips = [];
  const doubles = [...new Set((w.match(/([a-z])\1/g) || []))];
  if (doubles.length) tips.push(`Double letter${doubles.length > 1 ? 's' : ''}: <b>${doubles.join('</b> and <b>')}</b>.`);
  if (/ph/.test(w)) tips.push('<b>ph</b> makes an “f” sound here, a sign of a Greek word.');
  if (/^rh|rrh/.test(w)) tips.push('Silent <b>h</b> after the r (from Greek).');
  if (/^kn/.test(w)) tips.push('Silent <b>k</b> at the start.');
  if (/^gn/.test(w)) tips.push('Silent <b>g</b> at the start.');
  if (/^wr/.test(w)) tips.push('Silent <b>w</b> at the start.');
  if (/^p[sn]/.test(w)) tips.push(`Silent <b>p</b> at the start (from Greek).`);
  if (/mb$/.test(w)) tips.push('Silent <b>b</b> at the end.');
  if (/mn$/.test(w)) tips.push('Silent <b>n</b> at the end.');
  if (/gh/.test(w) && !/gh/.test(pron)) tips.push('Silent or tricky <b>gh</b>.');
  if (/ch/.test(w) && /k/.test(pron) && !/ch/.test(pron)) tips.push('<b>ch</b> sounds like “k” here, a sign of a Greek word.');
  if (/sc[ei]/.test(w)) tips.push('<b>sc</b> before e or i sounds like “s”.');
  if (/cei/.test(w)) tips.push('<b>ei</b> after c: “i before e, except after c”.');
  else if (/ei/.test(w)) tips.push('This word uses <b>ei</b>, one of the exceptions to “i before e”.');
  else if (/ie/.test(w) && !/ie$/.test(w)) tips.push('This word uses <b>ie</b>.');
  for (const [re, tip] of ENDINGS) if (re.test(w)) { tips.push(tip); break; }
  return tips;
}

// Turns her past wrong spellings into "watch out for..." tips.
function personalTips(word, history = []) {
  const wrongs = [...new Set(history.filter(h => !h.ok && h.typed).map(h => h.typed.toLowerCase()))].slice(-3);
  const tips = [];
  for (const typed of wrongs) {
    const cols = alignSpelling(typed, word);
    // Only for near misses; a completely different answer gives no useful hint.
    if (cols.filter(c => c.kind !== 'ok').length > Math.max(2, Math.floor(word.length / 3))) continue;
    const notes = [];
    cols.forEach(c => {
      if (c.kind === 'missing') notes.push(`don’t forget the <b>${e(c.right)}</b>`);
      else if (c.kind === 'extra') notes.push(`no extra <b>${e(c.typed)}</b>`);
      else if (c.kind === 'wrong') notes.push(`it’s <b>${e(c.right)}</b>, not ${e(c.typed)}`);
    });
    if (!notes.length) continue;
    const marked = cols.filter(c => c.right).map(c => c.kind === 'ok' ? e(c.right) : `<mark>${e(c.right)}</mark>`).join('');
    const said = notes.slice(0, 2).join('; ');
    tips.push(`You once wrote <s>${e(typed)}</s>. ${said[0].toUpperCase() + said.slice(1)}: ${marked}`);
  }
  return tips;
}

export function autoTips(w, progress) {
  const tips = [];
  for (const html of personalTips(w.word, progress?.history)) tips.push({ html, kind: 'personal' });
  const chunks = w.syllables || chunk(w.word);
  if (chunks && chunks.includes('·')) tips.push({ html: `Break it into parts: <b>${e(chunks)}</b>`, kind: 'chunks' });
  for (const html of patternTips(w.word, w.pronunciation)) tips.push({ html, kind: 'pattern' });
  return tips.slice(0, 5);
}
