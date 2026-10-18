// Checking spellings and remembering how each word has gone over time.

import * as db from './db.js';
import { todayKey } from './util.js';

export const RETEST_TARGET = 2; // correct in a row needed to leave the Mistakes list
const HISTORY_LIMIT = 60;

export function normalise(s) {
  return String(s ?? '').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
}

export function isCorrect(typed, word) {
  return normalise(typed) === normalise(word);
}

// Lines up her spelling against the right one, letter by letter.
// Returns columns: { typed, right, kind } where kind is ok | wrong | extra | missing.
export function alignSpelling(typed, word) {
  const a = [...normalise(typed)];
  const b = [...normalise(word)];
  const n = a.length, m = b.length;
  const d = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j - 1] + cost, d[i - 1][j] + 1, d[i][j - 1] + 1);
      // Swapped neighbours ("recieve") count as one mistake.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  const cols = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1] && a[i - 1] !== b[j - 1] && d[i][j] === d[i - 2][j - 2] + 1) {
      cols.push({ typed: a[i - 1], right: b[j - 1], kind: 'wrong' }, { typed: a[i - 2], right: b[j - 2], kind: 'wrong' });
      i -= 2; j -= 2;
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      cols.push({ typed: a[i - 1], right: b[j - 1], kind: a[i - 1] === b[j - 1] ? 'ok' : 'wrong' });
      i--; j--;
    } else if (j > 0 && (i === 0 || d[i][j] === d[i][j - 1] + 1)) {
      cols.push({ typed: '', right: b[j - 1], kind: 'missing' });
      j--;
    } else {
      cols.push({ typed: a[i - 1], right: '', kind: 'extra' });
      i--;
    }
  }
  return cols.reverse();
}

function snapshot(w) {
  const { word, pronunciation, pos, definition, etymology, sentence, tip, listId, n } = w;
  return { word, pronunciation, pos, definition, etymology, sentence, tip, listId, n, id: w.id };
}

// Records one attempt. mode is 'practice' or 'retest'.
// Returns the updated progress record (with .justCleared when it left the Mistakes list).
export async function recordAttempt(w, typed, ok, mode) {
  const key = w.key || normalise(w.word);
  const p = (await db.get('progress', key)) || {
    key, attempts: 0, correct: 0, wrong: 0, history: [], inMistakes: false, retestStreak: 0, timesCleared: 0,
  };
  p.w = snapshot(w);
  p.attempts++;
  p.lastSeen = Date.now();
  if (ok) p.correct++; else p.wrong++;
  p.history.push({ date: new Date().toISOString(), typed: typed || '', ok, mode });
  if (p.history.length > HISTORY_LIMIT) p.history = p.history.slice(-HISTORY_LIMIT);

  p.justCleared = false;
  if (!ok) {
    p.inMistakes = true;
    p.retestStreak = 0;
  } else if (p.inMistakes && mode === 'retest') {
    p.retestStreak++;
    if (p.retestStreak >= RETEST_TARGET) {
      p.inMistakes = false;
      p.retestStreak = 0;
      p.timesCleared++;
      p.justCleared = true;
    }
  }
  const { justCleared, ...stored } = p;
  await db.put('progress', stored);
  await bumpDayStreak();
  return p;
}

export function isTricky(p) {
  return (p?.wrong || 0) >= 2;
}

// ---- Streaks ----

export async function bumpDayStreak() {
  const stats = await db.getKV('stats', {});
  const today = todayKey();
  if (stats.lastDay === today) return stats;
  const yesterday = todayKey(new Date(Date.now() - 864e5));
  stats.dayStreak = stats.lastDay === yesterday ? (stats.dayStreak || 0) + 1 : 1;
  stats.bestDayStreak = Math.max(stats.bestDayStreak || 0, stats.dayStreak);
  stats.lastDay = today;
  await db.setKV('stats', stats);
  return stats;
}

export async function recordRun(run) {
  const stats = await db.getKV('stats', {});
  if (run > (stats.bestRun || 0)) {
    stats.bestRun = run;
    await db.setKV('stats', stats);
    return true;
  }
  return false;
}

export async function currentDayStreak() {
  const stats = await db.getKV('stats', {});
  const alive = stats.lastDay === todayKey() || stats.lastDay === todayKey(new Date(Date.now() - 864e5));
  return alive ? stats.dayStreak || 0 : 0;
}
