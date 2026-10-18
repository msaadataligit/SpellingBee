// Practice and Retest: the app says a word, she types it, the app checks it.

import * as db from './db.js';
import { escapeHtml as e, richText, plainText, originSummary, originSpoken } from './util.js';
import { speak, stopSpeaking, speechSupported } from './speech.js';
import { isCorrect, alignSpelling, recordAttempt, recordRun, isTricky, RETEST_TARGET } from './progress.js';
import { toast, onLeave, playSound } from './ui.js';
import { fillGaps, hasGaps } from './lookup.js';
import { autoTips } from './tips.js';

const app = document.getElementById('app');
let session = null;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function seg(name, options, current) {
  return `<div class="seg" role="group" data-seg="${name}">${options.map(([v, label]) =>
    `<button type="button" data-v="${e(v)}" aria-pressed="${String(v) === String(current)}">${label}</button>`).join('')}</div>`;
}

function wireSegs(onChange) {
  app.querySelectorAll('[data-seg]').forEach(group => {
    group.querySelectorAll('button').forEach(b => b.onclick = () => {
      group.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      onChange(group.dataset.seg, b.dataset.v);
    });
  });
}

function timerFields(settings) {
  return `
    <label class="switch setting"><span><b>⏱️ Countdown timer</b><br><span class="muted small">Spell before time runs out, like a real bee</span></span>
      <input type="checkbox" id="timer-on" ${settings.timerOn ? 'checked' : ''}></label>
    <label class="field" id="timer-secs" ${settings.timerOn ? '' : 'hidden'}><span>Seconds per word</span>
      <select id="timer-seconds">${[30, 45, 60, 90, 120].map(s => `<option ${s === settings.timerSeconds ? 'selected' : ''}>${s}</option>`).join('')}</select></label>`;
}

function wireTimerFields(save) {
  app.querySelector('#timer-on').onchange = ev => { save({ timerOn: ev.target.checked }); app.querySelector('#timer-secs').hidden = !ev.target.checked; };
  app.querySelector('#timer-seconds').onchange = ev => save({ timerSeconds: +ev.target.value });
}

function resumeCard(mode) {
  if (!session || session.mode !== mode || session.finished) return '';
  return `<div class="card" style="background:var(--honey-soft)">
    <b>You have a round in progress</b> <span class="muted">(${session.done} done)</span>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="resume">▶ Continue</button></div></div>`;
}

// ---------- Practice setup ----------

export async function practiceSetup() {
  let settings = await db.getSettings();
  const lists = await db.getAll('lists');
  const list = lists.find(l => l.id === settings.activeListId) || lists[0];
  if (!list) { location.hash = '#/lists'; return; }
  const seqPos = await db.getKV('seq:' + list.id, 1);
  const save = async patch => { settings = await db.saveSettings(patch); };

  app.innerHTML = `
    <a class="back" href="#/">← Home</a>
    <h1>🎯 Practice</h1>
    ${resumeCard('practice')}
    <div class="card">
      <p class="muted" style="margin-bottom:4px">Word list</p>
      <p><b>${e(list.name)}</b> · ${list.count.toLocaleString()} words ${lists.length > 1 ? '· <a href="#/lists">change</a>' : ''}</p>
      <div class="setting"><b>Order</b><br>${seg('order', [['shuffle', '🔀 Shuffled'], ['sequence', '➡️ In order']], settings.order)}</div>
      <label class="field setting" id="start-at" ${settings.order === 'sequence' ? '' : 'hidden'}><span>Start at word number</span>
        <input type="number" id="start-n" min="1" max="${list.count}" value="${Math.min(seqPos, list.count)}" inputmode="numeric"></label>
      <div class="setting"><b>How many words?</b><br>${seg('size', [[10, '10'], [20, '20'], [50, '50'], [0, 'All']], settings.sessionSize)}</div>
      <div class="setting"><b>Accent</b><br>${seg('accent', [['en-GB', '🇬🇧 British'], ['en-US', '🇺🇸 American']], settings.accent)}</div>
      ${timerFields(settings)}
      <label class="switch setting"><span><b>Skip words I already know</b><br><span class="muted small">Leaves out words spelled right first time before</span></span>
        <input type="checkbox" id="skip-known" ${settings.skipKnown ? 'checked' : ''}></label>
    </div>
    ${speechSupported ? '' : '<div class="warn">This browser can’t speak words aloud. Please use Chrome or Safari.</div>'}
    <button class="btn primary block" id="start" style="min-height:68px;font-size:22px">Start ▶</button>`;

  wireSegs((name, v) => {
    if (name === 'order') { save({ order: v }); app.querySelector('#start-at').hidden = v !== 'sequence'; }
    if (name === 'size') save({ sessionSize: +v });
    if (name === 'accent') save({ accent: v, voiceName: '' });
  });
  wireTimerFields(save);
  app.querySelector('#skip-known').onchange = ev => save({ skipKnown: ev.target.checked });
  app.querySelector('#resume')?.addEventListener('click', () => showWord());

  app.querySelector('#start').onclick = async () => {
    settings = await db.getSettings();
    let words = await db.wordsOfList(list.id);
    if (settings.skipKnown) {
      const prog = new Map((await db.getAll('progress')).map(p => [p.key, p]));
      const fresh = words.filter(w => { const p = prog.get(w.key); return !(p && p.correct > 0 && p.wrong === 0); });
      if (fresh.length) words = fresh; else toast('You know every word! Practising them all again.');
    }
    if (settings.order === 'sequence') {
      const startN = Math.max(1, +app.querySelector('#start-n').value || 1);
      const i = words.findIndex(w => w.n >= startN);
      words = i < 0 ? words : words.slice(i);
    } else words = shuffle(words);
    if (settings.sessionSize) words = words.slice(0, settings.sessionSize);
    if (!words.length) { toast('No words to practise from there.'); return; }
    startSession('practice', words, settings, list.id);
  };
}

// ---------- Retest setup (Mistakes list) ----------

export async function retestSetup() {
  let settings = await db.getSettings();
  const all = await db.getAll('progress');
  const mistakes = all.filter(p => p.inMistakes).sort((a, b) => b.wrong - a.wrong || b.lastSeen - a.lastSeen);
  const cleared = all.filter(p => !p.inMistakes && p.timesCleared > 0).sort((a, b) => b.lastSeen - a.lastSeen);
  const save = async patch => { settings = await db.saveSettings(patch); };

  const dots = p => Array.from({ length: RETEST_TARGET }, (_, i) => `<span class="dot ${i < p.retestStreak ? 'on' : ''}"></span>`).join('');
  const row = p => {
    const wrongs = p.history.filter(h => !h.ok);
    return `<details class="mistake">
      <summary><span class="w">${e(p.w?.word || p.key)}</span>
        ${isTricky(p) ? '<span class="tag tricky">🌶️ tricky</span>' : ''}
        <span class="tag">✗ ${p.wrong}</span><span class="spacer"></span>${p.inMistakes ? `<span class="dots" title="${p.retestStreak} of ${RETEST_TARGET} correct in a row">${dots(p)}</span>` : ''}</summary>
      <div class="small">
        ${wrongs.slice(-8).reverse().map(h => `<div><span class="muted">${new Date(h.date).toLocaleDateString()}</span> · you wrote <b class="bad-text">${e(h.typed || '(nothing)')}</b></div>`).join('')}
        ${p.timesCleared ? `<div class="muted">Cleared from Mistakes ${p.timesCleared} time${p.timesCleared > 1 ? 's' : ''} before.</div>` : ''}
        ${p.w?.listId ? `<a href="#/word/${e(p.w.listId)}/${p.w.n}">See meaning &amp; origin →</a>` : ''}
      </div></details>`;
  };

  app.innerHTML = `
    <a class="back" href="#/">← Home</a>
    <h1>🔁 Retest mistakes</h1>
    ${resumeCard('retest')}
    ${mistakes.length ? `
      <div class="card">
        <p>You have <b>${mistakes.length}</b> word${mistakes.length > 1 ? 's' : ''} to retest. Spell each one right <b>twice in a row</b> to clear it.</p>
        <div class="setting"><b>Accent</b><br>${seg('accent', [['en-GB', '🇬🇧 British'], ['en-US', '🇺🇸 American']], settings.accent)}</div>
        ${timerFields(settings)}
      </div>
      <button class="btn primary block" id="start" style="min-height:68px;font-size:22px">Start retest ▶</button>
      <h2>My mistakes list</h2>
      <p class="muted small">Tap a word to see every way you've spelled it before.</p>
      <div class="card" style="padding:6px 14px">${mistakes.map(row).join('')}</div>`
    : `<div class="card word-hero"><div style="font-size:56px">🌟</div><h2 style="margin-top:0">No mistakes to retest!</h2>
        <p class="muted">Words you get wrong in Practice will appear here.</p><a class="btn primary" href="#/practice">Go practise</a></div>`}
    ${cleared.length ? `<h2>Cleared words ✅</h2><p class="muted small">Words you used to get wrong, now fixed. Their history is kept.</p>
      <div class="card" style="padding:6px 14px">${cleared.slice(0, 50).map(row).join('')}</div>` : ''}`;

  wireSegs((name, v) => { if (name === 'accent') save({ accent: v, voiceName: '' }); });
  if (mistakes.length) wireTimerFields(save);
  app.querySelector('#resume')?.addEventListener('click', () => showWord());
  app.querySelector('#start')?.addEventListener('click', async () => {
    settings = await db.getSettings();
    // Use the latest version of each word from its list, if it still exists.
    const words = [];
    for (const p of shuffle(mistakes)) {
      const live = p.w?.id ? await db.get('words', p.w.id) : null;
      words.push(live && live.key === p.key ? live : { ...p.w, key: p.key });
    }
    startSession('retest', words, settings);
  });
}

// ---------- The round ----------

function startSession(mode, words, settings, listId) {
  session = { mode, queue: words, settings, listId, done: 0, right: 0, run: 0, bestRun: 0, missed: [], cleared: [], total: words.length, finished: false };
  showWord(true);
}

function wordLabel() {
  if (session.mode === 'retest') return `${session.queue.length} word${session.queue.length === 1 ? '' : 's'} left`;
  return `Word ${session.done + 1} of ${session.total}`;
}

function sentenceSpoken(w) {
  return plainText(w.sentence).replace(/_{2,}/g, w.word);
}

function showWord(first = false) {
  if (!session || !session.queue.length) return showSummary();
  const w = session.queue[0];
  const s = session.settings;
  const origin = originSummary(w.etymology);

  app.innerHTML = `
    <div class="session-top">
      <a class="back" href="#/" style="margin:0">✕ Stop</a>
      <b>${wordLabel()}</b>
      <span class="pill run" title="Correct in a row">🔥 ${session.run}</span>
    </div>
    ${s.timerOn ? `<div class="timer"><div class="timer-fill"></div><span class="timer-text"></span></div>` : ''}
    <div class="card ask-card">
      <button class="btn primary hear" id="hear">🔊 Say the word</button>
      <p class="muted small" style="text-align:center;margin:10px 0 6px">Ask the judge:</p>
      <div class="ask-grid">
        <button class="btn quiet" data-ask="definition" ${w.definition ? '' : 'disabled'}>📖 Definition</button>
        <button class="btn quiet" data-ask="sentence" ${w.sentence ? '' : 'disabled'}>💬 Sentence</button>
        <button class="btn quiet" data-ask="origin" ${w.etymology ? '' : 'disabled'}>🌍 Origin</button>
        <button class="btn quiet" data-ask="pos" ${w.pos ? '' : 'disabled'}>🏷️ Part of speech</button>
      </div>
      <div class="said" id="said" aria-live="polite"></div>
    </div>
    <form id="answer-form" autocomplete="off">
      <label for="answer" class="sr-only">Type your spelling</label>
      <input id="answer" class="answer" name="bee-${Date.now()}" type="text" placeholder="Type the spelling…"
        autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" enterkeyhint="done">
      <button class="btn good block" type="submit" style="min-height:64px;font-size:22px;margin-top:12px">✓ Check</button>
    </form>`;

  const said = app.querySelector('#said');
  const input = app.querySelector('#answer');
  const sayWord = () => { speak(w.word, s); said.innerHTML = '<span class="muted">🔊 Listen…</span>'; };
  app.querySelector('#hear').onclick = () => { sayWord(); input.focus(); };
  app.querySelectorAll('[data-ask]').forEach(b => b.onclick = () => {
    const kind = b.dataset.ask;
    if (kind === 'definition') { said.innerHTML = `<b>📖 Definition:</b> ${richText(w.definition)}`; speak(plainText(w.definition), s); }
    if (kind === 'sentence') { said.innerHTML = `<b>💬 Sentence:</b> ${richText(w.sentence).replace(/_{2,}/g, '_____')}`; speak(sentenceSpoken(w), s); }
    if (kind === 'origin') {
      said.innerHTML = `<b>🌍 Origin:</b> ${origin ? e(origin) : richText(w.etymology)}`;
      speak(originSpoken(w.etymology) || plainText(w.etymology).replace(/_{2,}/g, ''), s);
    }
    if (kind === 'pos') { said.innerHTML = `<b>🏷️ Part of speech:</b> ${e(w.pos)}`; speak(`It is ${/^[aeiou]/i.test(w.pos) ? 'an' : 'a'} ${w.pos}.`, s); }
  });

  // Missing info in the list? Fetch it quietly so the judge buttons work.
  if (hasGaps(w)) {
    fillGaps(w).then(x => {
      for (const f of ['definition', 'sentence', 'etymology', 'pos']) if (!w[f] && x[f]) w[f] = x[f];
      w.webSources = x.webSources;
      app.querySelectorAll('[data-ask]').forEach(b => { if (w[b.dataset.ask === 'origin' ? 'etymology' : b.dataset.ask]) b.disabled = false; });
    }).catch(() => {});
  }

  let timer = null;
  const submit = () => {
    if (timer) clearInterval(timer);
    stopSpeaking();
    checkAnswer(input.value);
  };
  app.querySelector('#answer-form').onsubmit = ev => {
    ev.preventDefault();
    if (!input.value.trim()) { input.focus(); toast('Type your spelling first'); return; }
    submit();
  };

  if (s.timerOn) {
    const total = s.timerSeconds * 1000;
    const started = Date.now();
    const fill = app.querySelector('.timer-fill');
    const text = app.querySelector('.timer-text');
    const tick = () => {
      const left = Math.max(0, total - (Date.now() - started));
      fill.style.width = (left / total * 100) + '%';
      fill.classList.toggle('low', left < 10000);
      text.textContent = Math.ceil(left / 1000) + 's';
      if (left <= 0) { toast('⏰ Time’s up!'); submit(); }
    };
    tick();
    timer = setInterval(tick, 200);
    onLeave(() => clearInterval(timer));
  }
  onLeave(stopSpeaking);

  setTimeout(() => { sayWord(); if (!first || window.matchMedia('(pointer: fine)').matches) input.focus(); }, first ? 300 : 150);
}

async function checkAnswer(typed) {
  const w = session.queue.shift();
  const ok = isCorrect(typed, w.word);
  const p = await recordAttempt(w, typed, ok, session.mode);
  session.done++;
  if (ok) {
    session.right++; session.run++;
    session.bestRun = Math.max(session.bestRun, session.run);
  } else {
    session.run = 0;
    if (!session.missed.some(m => m.word === w.word)) session.missed.push(w);
  }
  if (p.justCleared) session.cleared.push(w);
  // In a retest, a word comes back later in the round until it is cleared.
  if (session.mode === 'retest' && p.inMistakes) session.queue.splice(Math.min(3, session.queue.length), 0, w);
  if (session.mode === 'practice' && session.listId) await db.setKV('seq:' + session.listId, (w.n || 0) + 1);
  showResult(w, typed, ok, p);
}

function showResult(w, typed, ok, p) {
  const s = session.settings;
  const last = !session.queue.length;
  const retestInfo = session.mode === 'retest'
    ? (p.justCleared ? `<p class="cleared">🎉 Cleared from your Mistakes list!</p>`
      : p.inMistakes ? `<p class="muted">${ok ? `${RETEST_TARGET - p.retestStreak} more correct in a row to clear it.` : 'It will come back again in this round.'}</p>` : '')
    : '';
  const history = !ok && p.wrong > 1 ? `<p class="small muted">This word has tripped you up <b>${p.wrong} times</b>. Past spellings: ${
    [...new Set(p.history.filter(h => !h.ok).map(h => h.typed).filter(Boolean))].slice(-5).map(t => `<b class="bad-text">${e(t)}</b>`).join(', ')}</p>` : '';

  const cols = ok ? [] : alignSpelling(typed, w.word);
  const tips = ok ? [] : autoTips(w, p).slice(0, 3);
  const grid = cols.length ? `
    <div class="compare" aria-label="Your spelling compared with the correct spelling">
      <div class="compare-labels"><span>You</span><span>Correct</span></div>
      ${cols.map(c => `<div class="col ${c.kind}"><span class="t">${e(c.typed) || '&nbsp;'}</span><span class="r">${e(c.right) || '&nbsp;'}</span></div>`).join('')}
    </div>
    <p class="legend small"><span class="key wrong"></span> wrong letter <span class="key missing"></span> missing <span class="key extra"></span> extra</p>` : '';

  app.innerHTML = `
    <div class="session-top">
      <a class="back" href="#/" style="margin:0">✕ Stop</a>
      <b>${session.mode === 'retest' ? wordLabel() : `Word ${session.done} of ${session.total}`}</b>
      <span class="pill run">🔥 ${session.run}</span>
    </div>
    <div class="card result ${ok ? 'good' : 'bad'}">
      <div class="verdict">${ok ? '✅ Correct!' : '❌ Not quite'}</div>
      <div class="the-word">${e(w.word)}</div>
      ${w.pronunciation ? `<div class="say">${e(w.pronunciation)}</div>` : ''}
      ${ok && session.run >= 3 ? `<p class="streak-msg">🔥 ${session.run} in a row!</p>` : ''}
      ${grid}
      ${retestInfo}
      ${history}
      <div class="row" style="justify-content:center;margin-top:8px">
        <button class="btn quiet small" id="spell-it">🔤 Hear it spelled</button>
      </div>
    </div>
    ${ok ? '' : `<div class="card info-mini">
      ${w.definition ? `<p><b>📖 Meaning:</b> ${richText(w.definition)}</p>` : ''}
      ${w.etymology ? `<p><b>🌍 Origin:</b> ${originSummary(w.etymology) && originSummary(w.etymology) !== plainText(w.etymology).trim()
        ? `<b>${e(originSummary(w.etymology))}</b>. <span class="small">${richText(w.etymology)}</span>` : richText(w.etymology)}</p>` : ''}
      ${w.sentence ? `<p><b>💬 Sentence:</b> ${richText(w.sentence).replace(/_{2,}/g, `<mark>${e(w.word)}</mark>`)}</p>` : ''}
      ${w.tip ? `<p><b>💡 Tip:</b> ${richText(w.tip)}</p>` : ''}
      ${tips.length ? `<p style="margin-bottom:4px"><b>💡 Remember:</b></p><ul class="tips">${tips.map(t => `<li class="${t.kind}">${t.html}</li>`).join('')}</ul>` : ''}
      ${w.webSources && Object.keys(w.webSources).length ? `<p class="small muted">🌐 Some details came from ${[...new Set(Object.values(w.webSources))].map(s => s === 'freedict' ? 'Free Dictionary' : 'Wiktionary').join(' and ')}.</p>` : ''}
    </div>`}
    <button class="btn primary block" id="next" style="min-height:64px;font-size:22px">${last ? 'Finish 🏁' : 'Next word →'}</button>`;

  playSound(ok ? 'correct' : 'wrong', s);
  const letters = [...w.word.toLowerCase()].filter(c => /[a-z]/.test(c)).join(', ');
  speak(ok ? 'Correct!' : `Not quite. ${w.word} is spelled: ${letters}.`, s);
  app.querySelector('#spell-it').onclick = () => speak(`${w.word}. ${letters}. ${w.word}.`, s, { rate: 0.75 });
  const next = app.querySelector('#next');
  next.onclick = () => (last ? showSummary() : showWord());
  setTimeout(() => next.focus({ preventScroll: true }), 50);
  onLeave(stopSpeaking);
}

async function showSummary() {
  if (!session) { location.hash = '#/'; return; }
  session.finished = true;
  const newBest = await recordRun(session.bestRun);
  const pct = session.done ? Math.round(session.right / session.done * 100) : 0;
  const mode = session.mode;
  const missed = session.missed;
  const cleared = session.cleared;
  playSound('done', session.settings);
  const cheer = mode === 'retest' ? 'Retest complete!' : pct === 100 ? 'Perfect round!' : pct >= 80 ? 'Brilliant work!' : pct >= 50 ? 'Good effort!' : 'Keep going, you\'re learning!';

  app.innerHTML = `
    <div class="card word-hero">
      <div style="font-size:60px">${pct >= 80 || mode === 'retest' ? '🏆' : '🐝'}</div>
      <h1 style="margin:0 0 6px">${cheer}</h1>
      <p style="font-size:22px"><b>${session.right}</b> right out of <b>${session.done}</b> ${mode === 'retest' ? 'tries' : 'words'}</p>
      <p>🔥 Best run this round: <b>${session.bestRun}</b>${newBest && session.bestRun > 1 ? ' · <b>a new record!</b>' : ''}</p>
    </div>
    ${cleared.length ? `<div class="card"><h3>✅ Cleared from Mistakes</h3><p>${cleared.map(w => `<b>${e(w.word)}</b>`).join(', ')}</p></div>` : ''}
    ${missed.length && mode === 'practice' ? `<div class="card"><h3>📝 Added to your Mistakes list</h3>
      <p>${missed.map(w => w.listId ? `<a href="#/word/${e(w.listId)}/${w.n}"><b>${e(w.word)}</b></a>` : `<b>${e(w.word)}</b>`).join(', ')}</p>
      <p class="muted small">Retest them to clear them from the list.</p></div>` : ''}
    <div class="row" style="justify-content:center">
      ${missed.length && mode === 'practice' ? '<a class="btn primary" href="#/retest">🔁 Retest mistakes</a>' : ''}
      <a class="btn ${missed.length && mode === 'practice' ? '' : 'primary'}" href="#/practice">🎯 Practise more</a>
      <a class="btn quiet" href="#/">🏠 Home</a>
    </div>`;
  session = null;
}
