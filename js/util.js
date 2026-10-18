// Small shared helpers: HTML escaping, rich-text formatting, origin summaries.

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Word lists from dictionary sources often mark italics as {it}...{/it}.
export function richText(s) {
  return escapeHtml(s)
    .replace(/\{it\}/g, '<i>').replace(/\{\/it\}/g, '</i>')
    .replace(/\{\/?[a-z]+\}/g, '');
}

export function plainText(s) {
  return String(s ?? '').replace(/\{\/?[a-z]+\}/g, '');
}

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// Languages listed longest-first so "Old French" wins over "French".
const LANGUAGES = [
  'Old High German', 'Middle High German', 'Scottish Gaelic', 'Native American',
  'Old English', 'Middle English', 'Old French', 'Middle French', 'Anglo-French', 'Anglo-Norman',
  'Late Latin', 'Medieval Latin', 'New Latin', 'Vulgar Latin', 'Ancient Greek', 'Late Greek',
  'Old Norse', 'Middle Dutch', 'Old Irish', 'Low German', 'High German', 'Old Spanish', 'Old Italian',
  'Latin', 'Greek', 'French', 'German', 'Dutch', 'Italian', 'Spanish', 'Portuguese', 'Arabic',
  'Persian', 'Hindi', 'Sanskrit', 'Japanese', 'Chinese', 'Mandarin', 'Cantonese', 'Hebrew', 'Yiddish',
  'Russian', 'Turkish', 'Malay', 'Tamil', 'Urdu', 'Swahili', 'Nahuatl', 'Quechua', 'Hawaiian',
  'Maori', 'Irish', 'Gaelic', 'Welsh', 'Celtic', 'Scandinavian', 'Norwegian', 'Swedish', 'Danish',
  'Icelandic', 'Norse', 'Polish', 'Czech', 'Hungarian', 'Finnish', 'Korean', 'Tibetan', 'Bengali',
  'Afrikaans', 'Zulu', 'Inuit', 'Algonquian', 'Taino', 'Tupi', 'Aramaic', 'Egyptian', 'Thai',
  'Vietnamese', 'Tagalog', 'Romani', 'Scots', 'English',
];
const LANG_RE = new RegExp('\\b(' + LANGUAGES.map(l => l.replace(/[-]/g, '\\-')).join('|') + ')\\b(?! (mythology|myth|legend))', 'g');

// Turns a dictionary etymology into a short chain of languages,
// e.g. "Middle English, from Old English; akin to ..." -> ['Middle English', 'Old English'].
export function originChain(etymology) {
  if (!etymology) return [];
  let t = String(etymology)
    .replace(/\{it\}.*?\{\/it\}/g, ' ')   // italic parts are quoted word forms, not languages
    .replace(/\([^)]*\)/g, ' ')
    .replace(/'[^']*'|"[^"]*"/g, ' ');
  t = t.split(/;|\bakin to\b|\s\+\s|\bcompare\b|\brelated to\b/i)[0];
  const seen = new Set(); const out = [];
  for (const m of t.matchAll(LANG_RE)) if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  return out.slice(0, 4);
}

export function originSummary(etymology) {
  const chain = originChain(etymology);
  if (!chain.length) return '';
  if (chain.length === 1) return chain[0];
  return chain[chain.length - 1] + ' (via ' + chain.slice(0, -1).join(', ') + ')';
}

export function originSpoken(etymology) {
  const chain = originChain(etymology);
  if (!chain.length) return '';
  return 'This word comes from ' + chain.join(', from ') + '.';
}

export function todayKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Loads a classic (non-module) script from a CDN once.
const loaded = {};
export function loadScript(src) {
  return loaded[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = resolve; s.onerror = () => { delete loaded[src]; reject(new Error('Could not load ' + src + '. Check the internet connection.')); };
    document.head.appendChild(s);
  });
}
