// "My progress": streaks, how much of the list she has covered, and her trickiest words.

import * as db from './db.js';
import { escapeHtml as e, todayKey } from './util.js';
import { currentDayStreak, isTricky, RETEST_TARGET } from './progress.js';
import { toast } from './ui.js';

const app = document.getElementById('app');

export async function progressScreen() {
  const [progress, stats, settings, lists, dayStreak] = await Promise.all([
    db.getAll('progress'), db.getKV('stats', {}), db.getSettings(), db.getAll('lists'), currentDayStreak(),
  ]);
  const list = lists.find(l => l.id === settings.activeListId) || lists[0];
  const attempts = progress.reduce((s, p) => s + p.attempts, 0);
  const right = progress.reduce((s, p) => s + p.correct, 0);
  const accuracy = attempts ? Math.round(right / attempts * 100) : 0;
  const inList = list ? progress.filter(p => p.w?.listId === list.id) : [];
  const known = inList.filter(p => p.correct > 0 && !p.inMistakes).length;
  const mistakes = progress.filter(p => p.inMistakes).length;
  const tricky = progress.filter(isTricky).sort((a, b) => b.wrong - a.wrong || b.lastSeen - a.lastSeen);

  // Last 7 days of activity.
  const byDay = {};
  for (const p of progress) for (const h of p.history) {
    const k = todayKey(new Date(h.date));
    (byDay[k] ||= { n: 0, ok: 0 }).n++;
    if (h.ok) byDay[k].ok++;
  }
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - (6 - i) * 864e5);
    return { label: d.toLocaleDateString(undefined, { weekday: 'short' }), ...(byDay[todayKey(d)] || { n: 0, ok: 0 }), today: i === 6 };
  });

  const row = p => `<details class="mistake">
      <summary><span class="w">${e(p.w?.word || p.key)}</span>
        <span class="tag">✗ ${p.wrong}</span><span class="tag ok">✓ ${p.correct}</span>
        <span class="spacer"></span>${p.inMistakes ? '<span class="small muted">to retest</span>' : '<span class="small" style="color:var(--good)">✅ cleared</span>'}</summary>
      <div class="small">
        ${p.history.filter(h => !h.ok).slice(-8).reverse().map(h => `<div><span class="muted">${new Date(h.date).toLocaleDateString()}</span> · you wrote <b class="bad-text">${e(h.typed || '(nothing)')}</b></div>`).join('')}
        ${p.w?.listId ? `<a href="#/word/${e(p.w.listId)}/${p.w.n}">Meaning, origin &amp; tips →</a>` : ''}
      </div></details>`;

  app.innerHTML = `
    <a class="back" href="#/">← Home</a>
    <h1>📈 My progress</h1>
    <div class="stats">
      <div class="stat"><b>${dayStreak}</b><span>day streak 🔥</span></div>
      <div class="stat"><b>${stats.bestDayStreak || 0}</b><span>best day streak</span></div>
      <div class="stat"><b>${stats.bestRun || 0}</b><span>most right in a row</span></div>
    </div>
    <div class="card">
      <h3>This week</h3>
      <div class="week">${days.map(d => `<div class="day ${d.n ? 'done' : ''} ${d.today ? 'today' : ''}" title="${d.n} words, ${d.ok} right">
        <span class="circle">${d.n ? d.n : ''}</span><span class="small">${e(d.label)}</span></div>`).join('')}</div>
      <p class="muted small" style="margin-top:10px">Numbers show how many words were spelled that day. Practise every day to grow your streak!</p>
    </div>
    ${list ? `<div class="card">
      <h3>${e(list.name)}</h3>
      <p><b>${known.toLocaleString()}</b> of ${list.count.toLocaleString()} words spelled right · <b>${inList.length.toLocaleString()}</b> tried</p>
      <div class="progress-bar" style="height:18px"><div style="width:${Math.min(100, known / list.count * 100)}%;background:var(--good)"></div></div>
      <p class="muted small" style="margin-top:10px">Overall accuracy: <b>${accuracy}%</b> of ${attempts.toLocaleString()} answers · ${mistakes} word${mistakes === 1 ? '' : 's'} waiting to retest</p>
    </div>` : ''}
    <h2>🌶️ Trickiest words</h2>
    ${tricky.length ? `<p class="muted small">Words you've got wrong two or more times. Tap one to see every spelling you've tried.</p>
      <div class="card" style="padding:6px 14px">${tricky.slice(0, 40).map(row).join('')}</div>`
      : '<div class="card"><p class="muted" style="margin:0">No tricky words yet. Words you get wrong more than once will show up here.</p></div>'}
    <details class="card parent">
      <summary><b>For parents</b></summary>
      <p class="small muted" style="margin-top:10px">Progress is stored only in this browser. Use Settings → Backup to copy it to another device.</p>
      <button class="btn small danger" id="reset">Reset all progress</button>
    </details>`;

  app.querySelector('#reset').onclick = async () => {
    if (!confirm('This deletes all practice history, mistakes and streaks on this device. Word lists are kept. Continue?')) return;
    await db.clear('progress');
    await db.setKV('stats', {});
    toast('Progress reset');
    progressScreen();
  };
}
