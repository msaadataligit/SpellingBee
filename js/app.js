import * as db from './db.js';
import { importFile, FIELDS, FIELD_LABELS } from './importer.js';
import { escapeHtml as e, richText, originSummary, debounce, todayKey } from './util.js';
import { speak, speechSupported, voicesFor, getVoices } from './speech.js';
import { toast, runLeave } from './ui.js';
import { practiceSetup, retestSetup } from './practice.js';
import { fillGaps, hasGaps, sourceLabel } from './lookup.js';
import { autoTips } from './tips.js';
import { progressScreen } from './stats.js';

const app = document.getElementById('app');
let settings = db.DEFAULT_SETTINGS;
let pendingImport = null; // result of reading a file, waiting to be saved

// ---------- Router ----------

const routes = [
  [/^\/?$/, home],
  [/^\/lists$/, listsScreen],
  [/^\/list\/([^/]+)$/, listScreen],
  [/^\/word\/([^/]+)\/(\d+)$/, wordScreen],
  [/^\/settings$/, settingsScreen],
  [/^\/practice$/, practiceSetup],
  [/^\/retest$/, retestSetup],
  [/^\/progress$/, progressScreen],
];

async function render() {
  runLeave();
  updateStreakPill();
  const path = decodeURIComponent(location.hash.replace(/^#/, '')) || '/';
  for (const [re, view] of routes) {
    const m = path.match(re);
    if (m) {
      try { await view(...m.slice(1)); }
      catch (err) { console.error(err); app.innerHTML = `<div class="error">Something went wrong: ${e(err.message)}</div>`; }
      app.focus({ preventScroll: true });
      window.scrollTo(0, 0);
      return;
    }
  }
  location.hash = '#/';
}

async function updateStreakPill() {
  const stats = await db.getKV('stats', {});
  const pill = document.getElementById('streak-pill');
  const n = stats.dayStreak || 0;
  const alive = stats.lastDay === todayKey() || stats.lastDay === todayKey(new Date(Date.now() - 864e5));
  pill.hidden = !(n && alive);
  pill.textContent = `🔥 ${n} day${n === 1 ? '' : 's'}`;
}

// ---------- Home ----------

async function home() {
  const [lists, progress, stats] = await Promise.all([db.getAll('lists'), db.getAll('progress'), db.getKV('stats', {})]);
  const mistakes = progress.filter(p => p.inMistakes).length;
  const mastered = progress.filter(p => p.correct > 0 && !p.inMistakes).length;
  const active = lists.find(l => l.id === settings.activeListId) || lists[0];
  const hasWords = !!active;

  app.innerHTML = `
    <div class="hello">
      <span class="big-bee" aria-hidden="true">🐝</span>
      <div>
        <h1 style="margin:0">Ready to spell?</h1>
        <p class="muted" style="margin:0">${hasWords ? `Practising <b>${e(active.name)}</b> · ${active.count.toLocaleString()} words` : 'Start by adding a word list.'}</p>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><b>${stats.dayStreak || 0}</b><span>day streak 🔥</span></div>
      <div class="stat"><b>${mastered}</b><span>words spelled right</span></div>
      <div class="stat"><b>${mistakes}</b><span>to retest</span></div>
    </div>
    <nav class="menu" aria-label="Main menu">
      ${hasWords
        ? `<a class="tile practice" href="#/practice"><span class="ico">🎯</span><b>Practice</b><span>Hear a word, spell it, see how you did</span></a>`
        : `<a class="tile practice" href="#/lists"><span class="ico">📄</span><b>Add your word list</b><span>Upload a PDF, Word, Excel, CSV or text file</span></a>`}
      <a class="tile retest" href="#/retest"><span class="ico">🔁</span><b>Retest mistakes</b><span>Spell each one right twice in a row</span>${mistakes ? `<span class="badge">${mistakes}</span>` : ''}</a>
      <a class="tile lists" href="#/lists"><span class="ico">📚</span><b>Word lists</b><span>Browse words, meanings &amp; origins</span></a>
      <a class="tile progress" href="#/progress"><span class="ico">📈</span><b>My progress</b><span>Streaks and tricky words</span></a>
      <a class="tile settings" href="#/settings"><span class="ico">⚙️</span><b>Settings</b><span>Voice, timer, backup</span></a>
    </nav>`;
}

// ---------- Word lists & upload ----------

async function listsScreen() {
  const lists = (await db.getAll('lists')).sort((a, b) => b.createdAt - a.createdAt);
  app.innerHTML = `
    <a class="back" href="#/">← Home</a>
    <h1>Word lists</h1>
    ${lists.length ? `<div class="card"><h2 style="margin-top:0">Your lists</h2>
      ${lists.map(l => `
        <div class="row setting">
          <div class="spacer"><a href="#/list/${e(l.id)}"><b>${e(l.name)}</b></a><br>
            <span class="muted small">${l.count.toLocaleString()} words · from ${e(l.fileName || 'a file')}${l.id === settings.activeListId ? ' · <b>practising this list</b>' : ''}</span></div>
          ${l.id === settings.activeListId ? '' : `<button class="btn small quiet" data-use="${e(l.id)}">Practise this</button>`}
          <a class="btn small" href="#/list/${e(l.id)}">Open</a>
        </div>`).join('')}
    </div>` : ''}
    <div class="card">
      <h2 style="margin-top:0">Add a word list</h2>
      <p class="muted">The file can include meanings, word origins, example sentences and memory tips. The app finds them automatically, and the file never leaves this device.</p>
      <label class="drop" id="drop">
        <span class="ico" aria-hidden="true">📄</span>
        <b>Tap to choose a file</b><br><span class="muted small">or drop it here · PDF, Word (.docx), Excel, CSV or text</span>
        <input type="file" id="file" accept=".pdf,.docx,.doc,.xlsx,.xls,.ods,.csv,.tsv,.txt,text/plain,application/pdf">
      </label>
      <div id="import-status"></div>
    </div>`;

  app.querySelectorAll('[data-use]').forEach(b => b.onclick = async () => {
    settings = await db.saveSettings({ activeListId: b.dataset.use });
    toast('Now practising this list');
    listsScreen();
  });

  const input = app.querySelector('#file');
  const drop = app.querySelector('#drop');
  input.onchange = () => input.files[0] && readFile(input.files[0]);
  drop.ondragover = ev => { ev.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = ev => { ev.preventDefault(); drop.classList.remove('over'); ev.dataTransfer.files[0] && readFile(ev.dataTransfer.files[0]); };
}

async function readFile(file) {
  const status = app.querySelector('#import-status');
  status.innerHTML = `<p style="margin-top:14px"><b>Reading ${e(file.name)}…</b></p><div class="progress-bar"><div></div></div>`;
  const bar = status.querySelector('.progress-bar > div');
  try {
    const result = await importFile(file, f => { bar.style.width = Math.round(f * 100) + '%'; });
    bar.style.width = '100%';
    if (!result.words.length) throw new Error('No words were found in this file.');
    pendingImport = { ...result, fileName: file.name };
    showImportPreview();
  } catch (err) {
    console.error(err);
    status.innerHTML = `<div class="error">${e(err.message)}</div>`;
  }
}

function showImportPreview() {
  const r = pendingImport;
  const status = app.querySelector('#import-status');
  const sample = r.words.slice(0, 3);
  const defaultName = r.fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  status.innerHTML = `
    <h2>Found ${r.words.length.toLocaleString()} words 🎉</h2>
    <div class="found">${FIELDS.map(f => `<span class="chip ${r.fieldsFound.includes(f) ? '' : 'missing'}">${r.fieldsFound.includes(f) ? '✓' : '–'} ${FIELD_LABELS[f]}</span>`).join('')}</div>
    ${r.fieldsFound.includes('tip') ? '' : '<p class="muted small">No memory tips in this file. You can add your own to any word later.</p>'}
    ${r.warnings.slice(0, 5).map(w => `<div class="warn">${e(w)}</div>`).join('')}
    ${r.warnings.length > 5 ? `<div class="warn">…and ${r.warnings.length - 5} more notes.</div>` : ''}
    <h3 style="margin-top:16px">First few words: please check they look right</h3>
    ${sample.map(w => `
      <div class="card" style="box-shadow:none">
        <b style="font-size:20px">${e(w.word)}</b> ${w.pronunciation ? `<span class="muted">${e(w.pronunciation)}</span>` : ''} ${w.pos ? `<i class="muted">${e(w.pos)}</i>` : ''}
        ${w.definition ? `<p class="small" style="margin:6px 0 0"><b>Meaning:</b> ${richText(w.definition)}</p>` : ''}
        ${w.etymology ? `<p class="small" style="margin:4px 0 0"><b>Origin:</b> ${richText(w.etymology)}</p>` : ''}
        ${w.sentence ? `<p class="small" style="margin:4px 0 0"><b>Sentence:</b> ${richText(w.sentence)}</p>` : ''}
      </div>`).join('')}
    <label class="field"><span>Name this list</span><input type="text" id="list-name" value="${e(defaultName)}" maxlength="80"></label>
    <div class="row">
      <button class="btn primary" id="save-list">✓ Save list</button>
      <button class="btn quiet" id="cancel-list">Cancel</button>
    </div>`;
  status.querySelector('#cancel-list').onclick = () => { pendingImport = null; status.innerHTML = ''; };
  status.querySelector('#save-list').onclick = async ev => {
    ev.target.disabled = true;
    const name = status.querySelector('#list-name').value.trim() || defaultName;
    const id = 'L' + Date.now().toString(36);
    const words = r.words.map(w => ({ ...w, id: `${id}:${w.n}`, listId: id, key: w.word.toLowerCase() }));
    await db.putMany('words', words);
    await db.put('lists', { id, name, fileName: r.fileName, count: words.length, createdAt: Date.now(), fields: r.fieldsFound });
    if (!settings.activeListId || !(await db.get('lists', settings.activeListId))) settings = await db.saveSettings({ activeListId: id });
    pendingImport = null;
    db.requestPersistence();
    toast(`Saved ${words.length.toLocaleString()} words`);
    location.hash = `#/list/${id}`;
  };
  status.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const PAGE = 50;

async function listScreen(listId) {
  const list = await db.get('lists', listId);
  if (!list) { location.hash = '#/lists'; return; }
  const words = await db.wordsOfList(listId);
  let query = '';
  let page = 0;

  app.innerHTML = `
    <a class="back" href="#/lists">← Word lists</a>
    <h1>${e(list.name)}</h1>
    <p class="muted">${list.count.toLocaleString()} words. Tap a word to see its meaning, origin and tips.</p>
    <input class="search" id="q" type="search" placeholder="🔍 Search words or meanings" autocomplete="off" autocapitalize="off" spellcheck="false">
    <ul class="wordlist" id="words"></ul>
    <div class="pager" id="pager"></div>
    <div class="card" style="margin-top:24px">
      <h3>List options</h3>
      <div class="row">
        ${list.id === settings.activeListId ? '<span class="chip">✓ Practising this list</span>' : '<button class="btn small" id="use">Practise this list</button>'}
        <button class="btn small danger" id="delete">Delete list</button>
      </div>
    </div>`;

  const ul = app.querySelector('#words');
  const pager = app.querySelector('#pager');
  const draw = () => {
    const q = query.toLowerCase();
    const shown = q ? words.filter(w => w.word.toLowerCase().includes(q) || w.definition.toLowerCase().includes(q)) : words;
    const pages = Math.max(1, Math.ceil(shown.length / PAGE));
    page = Math.min(page, pages - 1);
    ul.innerHTML = shown.slice(page * PAGE, page * PAGE + PAGE).map(w => `
      <li><a href="#/word/${e(listId)}/${w.n}"><span class="num">${w.n}</span><span class="w">${e(w.word)}</span><span class="d">${e(w.definition.replace(/\{\/?it\}/g, ''))}</span></a></li>`).join('')
      || '<li class="muted" style="padding:14px">No words match.</li>';
    pager.innerHTML = pages > 1 ? `
      <button class="btn small quiet" id="prev" ${page ? '' : 'disabled'}>← Back</button>
      <span class="muted">Page ${page + 1} of ${pages}</span>
      <button class="btn small quiet" id="next" ${page < pages - 1 ? '' : 'disabled'}>Next →</button>` : '';
    pager.querySelector('#prev')?.addEventListener('click', () => { page--; draw(); ul.scrollIntoView(); });
    pager.querySelector('#next')?.addEventListener('click', () => { page++; draw(); ul.scrollIntoView(); });
  };
  app.querySelector('#q').oninput = debounce(ev => { query = ev.target.value.trim(); page = 0; draw(); }, 150);
  draw();

  app.querySelector('#use')?.addEventListener('click', async () => {
    settings = await db.saveSettings({ activeListId: listId });
    toast('Now practising this list');
    listScreen(listId);
  });
  app.querySelector('#delete').onclick = async () => {
    if (!confirm(`Delete "${list.name}"? Practice history is kept, but the words will be removed from this device.`)) return;
    await db.deleteList(listId);
    if (settings.activeListId === listId) {
      const rest = await db.getAll('lists');
      settings = await db.saveSettings({ activeListId: rest[0]?.id || '' });
    }
    toast('List deleted');
    location.hash = '#/lists';
  };
}

// ---------- Word info ----------

function sentenceWithWord(sentence, word) {
  const html = richText(sentence);
  return /_{2,}/.test(html) ? html.replace(/_{2,}/g, `<mark>${e(word)}</mark>`) : html;
}

async function wordScreen(listId, n) {
  const w = await db.get('words', `${listId}:${n}`);
  if (!w) { location.hash = `#/list/${listId}`; return; }
  const prog = await db.get('progress', w.key);
  const fromList = '<span class="source">From your word list</span>';
  const fromYou = '<span class="source">Added by you</span>';
  const src = f => (w.edited || []).includes(f) ? fromYou : fromList;
  const extras = Object.entries(w.extras || {});

  app.innerHTML = `
    <a class="back" href="#/list/${e(listId)}">← Back to list</a>
    <div class="card word-hero">
      <div class="the-word">${e(w.word)}</div>
      ${w.pronunciation ? `<div class="say">${e(w.pronunciation)}</div>` : ''}
      ${w.pos ? `<span class="pos">${e(w.pos)}</span>` : ''}
      <div class="row" style="justify-content:center;margin-top:16px">
        ${speechSupported ? '<button class="btn primary" id="hear">🔊 Hear it</button>' : ''}
      </div>
    </div>
    ${prog?.history?.length ? `<div class="card"><h3>📝 Your history with this word</h3>
      <p class="small">${prog.correct || 0} right · ${prog.wrong || 0} wrong</p>
      ${prog.history.filter(h => !h.ok).slice(-5).reverse().map(h => `<div class="small muted">${new Date(h.date).toLocaleDateString()}: you wrote <b class="bad-text">${e(h.typed || '(nothing)')}</b></div>`).join('')}
    </div>` : ''}
    <div class="info-grid" id="info"></div>
    <p class="muted small" id="lookup-note"></p>
    <div class="row" style="margin-top:8px">
      <button class="btn quiet" id="edit">✏️ Edit</button>
      <span class="spacer"></span>
      ${+n > 1 ? `<a class="btn quiet small" href="#/word/${e(listId)}/${+n - 1}">← Previous</a>` : ''}
      <a class="btn quiet small" href="#/word/${e(listId)}/${+n + 1}">Next →</a>
    </div>
    <div id="edit-area"></div>`;

  const drawInfo = (x, loading) => {
    const srcOf = f => x.webSources?.[f] ? sourceLabel(x.webSources[f], x.word) : src(f);
    const missing = what => loading ? `<p class="muted">Looking this up online…</p>` : `<p class="muted">No ${what} found.</p>`;
    const org = originSummary(x.etymology);
    const tips = autoTips(x, prog);
    app.querySelector('#info').innerHTML = `
      <div class="card info meaning"><h3>📖 Meaning ${!w.pos && x.pos ? `<span class="pos">${e(x.pos)}</span>` : ''}</h3>${x.definition ? `<p>${richText(x.definition)}</p>${srcOf('definition')}` : missing('meaning')}</div>
      <div class="card info origin"><h3>🌍 Origin</h3>
        ${x.etymology ? `${org ? `<div class="origin-lang">${e(org)}</div>` : ''}<p class="small">${richText(x.etymology)}</p>${srcOf('etymology')}` : missing('origin')}</div>
      <div class="card info sentence"><h3>💬 In a sentence</h3>${x.sentence ? `<p>${sentenceWithWord(x.sentence, x.word)}</p>${srcOf('sentence')}` : missing('example sentence')}</div>
      <div class="card info tip"><h3>💡 Memory tips</h3>
        ${x.tip ? `<p>${richText(x.tip)}</p>${src('tip')}` : ''}
        ${tips.length ? `<ul class="tips">${tips.map(t => `<li class="${t.kind}">${t.html}</li>`).join('')}</ul>
          <span class="source">✨ Made by the app from the spelling${prog?.history?.some(h => !h.ok) ? ' and your past answers' : ''}${x.syllables ? ' · syllables from Wiktionary' : ''}</span>` : ''}
        ${!x.tip ? '<p class="muted small" style="margin-top:8px">Have your own trick? Tap “Edit” to add it.</p>' : ''}</div>
      ${extras.length ? `<div class="card info"><h3>🗒️ Other notes</h3>${extras.map(([k, v]) => `<p class="small"><b>${e(k)}:</b> ${e(v)}</p>`).join('')}${fromList}</div>` : ''}`;
  };
  drawInfo(w, hasGaps(w));
  fillGaps(w).then(x => {
    if (!app.querySelector('#info') || location.hash !== `#/word/${listId}/${n}`) return;
    drawInfo(x, false);
    if (x.lookupError && hasGaps(w)) app.querySelector('#lookup-note').textContent = x.lookupError === 'offline'
      ? 'You’re offline, so missing information couldn’t be looked up.' : 'The online dictionaries didn’t answer. Try again later.';
  }).catch(() => drawInfo(w, false));

  app.querySelector('#hear')?.addEventListener('click', () => speak(w.word, settings));
  app.querySelector('#edit').onclick = () => {
    const area = app.querySelector('#edit-area');
    area.innerHTML = `<div class="card" style="margin-top:16px"><h3>Edit “${e(w.word)}”</h3>
      ${FIELDS.map(f => `<label class="field"><span>${FIELD_LABELS[f]}</span>${['definition', 'etymology', 'sentence', 'tip'].includes(f)
        ? `<textarea data-f="${f}">${e(w[f])}</textarea>` : `<input type="text" data-f="${f}" value="${e(w[f])}">`}</label>`).join('')}
      <p class="muted small">In the sentence, use _____ where the word goes.</p>
      <div class="row"><button class="btn primary" id="save">Save</button><button class="btn quiet" id="cancel">Cancel</button></div></div>`;
    area.scrollIntoView({ behavior: 'smooth' });
    area.querySelector('#cancel').onclick = () => { area.innerHTML = ''; };
    area.querySelector('#save').onclick = async () => {
      const edited = new Set(w.edited || []);
      area.querySelectorAll('[data-f]').forEach(el => {
        const v = el.value.trim();
        if (v !== w[el.dataset.f]) { w[el.dataset.f] = v; edited.add(el.dataset.f); }
      });
      if (!w.word) { toast('The word can’t be empty'); return; }
      w.edited = [...edited];
      w.key = w.word.toLowerCase();
      await db.put('words', w);
      toast('Saved');
      wordScreen(listId, n);
    };
  };
}

// ---------- Settings ----------

async function settingsScreen() {
  const [gb, us, all] = await Promise.all([voicesFor('en-GB'), voicesFor('en-US'), getVoices()]);
  const voices = settings.accent === 'en-GB' ? gb : us;
  app.innerHTML = `
    <a class="back" href="#/">← Home</a>
    <h1>Settings</h1>
    <div class="card">
      <h2 style="margin-top:0">🔊 Voice</h2>
      ${speechSupported ? '' : '<div class="warn">This browser can’t speak words aloud. Try Chrome or Safari.</div>'}
      <div class="setting">
        <b>Accent</b><br>
        <div class="seg" role="group" aria-label="Accent" style="margin-top:8px">
          <button data-accent="en-GB" aria-pressed="${settings.accent === 'en-GB'}">🇬🇧 British</button>
          <button data-accent="en-US" aria-pressed="${settings.accent === 'en-US'}">🇺🇸 American</button>
        </div>
        ${!voices.length && all.length ? `<div class="warn">No ${settings.accent === 'en-GB' ? 'British' : 'American'} voice is installed on this device, so another English voice will be used.<br><b>Windows laptop:</b> Settings → Time &amp; language → Speech → Add voices → English (${settings.accent === 'en-GB' ? 'United Kingdom' : 'United States'}).<br><b>Android:</b> Settings → search “Text-to-speech” → Google → Install voice data → English (${settings.accent === 'en-GB' ? 'United Kingdom' : 'United States'}).</div>` : ''}
      </div>
      ${voices.length > 1 ? `<label class="field setting"><span>Voice</span><select id="voice">
        <option value="">Best available</option>
        ${voices.map(v => `<option value="${e(v.name)}" ${v.name === settings.voiceName ? 'selected' : ''}>${e(v.name)}${v.localService ? '' : ' (needs internet)'}</option>`).join('')}
      </select></label>` : ''}
      <label class="field setting"><span>Speaking speed: <output id="rate-out">${settings.rate}</output></span>
        <input type="range" id="rate" min="0.6" max="1.2" step="0.05" value="${settings.rate}" style="width:100%"></label>
      <button class="btn" id="test-voice">▶ Test voice</button>
    </div>
    <div class="card">
      <h2 style="margin-top:0">🎯 Practice</h2>
      <div class="setting"><b>Word order</b><br>
        <div class="seg" role="group" aria-label="Word order" style="margin-top:8px">
          <button data-order="shuffle" aria-pressed="${settings.order === 'shuffle'}">🔀 Shuffled</button>
          <button data-order="sequence" aria-pressed="${settings.order === 'sequence'}">➡️ In order</button>
        </div></div>
      <label class="switch setting"><span><b>Countdown timer</b><br><span class="muted small">Like a real bee: spell before time runs out</span></span>
        <input type="checkbox" id="timer-on" ${settings.timerOn ? 'checked' : ''}></label>
      <label class="field setting" ${settings.timerOn ? '' : 'hidden'} id="timer-secs"><span>Seconds per word</span>
        <select id="timer-seconds">${[30, 45, 60, 90, 120].map(s => `<option ${s === settings.timerSeconds ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label class="switch setting"><span><b>Sound effects</b></span><input type="checkbox" id="sounds" ${settings.sounds ? 'checked' : ''}></label>
    </div>
    <div class="card">
      <h2 style="margin-top:0">💾 Backup</h2>
      <p class="muted small">Progress is saved in this browser only. Save a backup file to keep it safe, or to move it to another device (for example from the laptop to a phone).</p>
      <div class="row">
        <button class="btn" id="export">⬇ Save backup file</button>
        <label class="btn quiet" style="cursor:pointer">⬆ Load backup file<input type="file" id="import" accept=".json,application/json" hidden></label>
      </div>
    </div>
    <p class="muted small" style="text-align:center">🔒 No accounts. Nothing about you is sent anywhere.</p>`;

  const save = async patch => { settings = await db.saveSettings(patch); };
  app.querySelectorAll('[data-accent]').forEach(b => b.onclick = async () => { await save({ accent: b.dataset.accent, voiceName: '' }); settingsScreen(); });
  app.querySelectorAll('[data-order]').forEach(b => b.onclick = async () => { await save({ order: b.dataset.order }); settingsScreen(); });
  app.querySelector('#voice')?.addEventListener('change', ev => save({ voiceName: ev.target.value }));
  const rate = app.querySelector('#rate');
  rate.oninput = () => { app.querySelector('#rate-out').textContent = rate.value; };
  rate.onchange = () => save({ rate: +rate.value });
  app.querySelector('#test-voice').onclick = () => speak('Your word is: necessary. Necessary.', settings);
  app.querySelector('#timer-on').onchange = async ev => { await save({ timerOn: ev.target.checked }); app.querySelector('#timer-secs').hidden = !ev.target.checked; };
  app.querySelector('#timer-seconds').onchange = ev => save({ timerSeconds: +ev.target.value });
  app.querySelector('#sounds').onchange = ev => save({ sounds: ev.target.checked });

  app.querySelector('#export').onclick = async () => {
    const data = await db.exportAll();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bee-ready-backup-${todayKey()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Backup saved to Downloads');
  };
  app.querySelector('#import').onchange = async ev => {
    const file = ev.target.files[0];
    if (!file) return;
    if (!confirm('Loading a backup replaces the word lists and progress on this device. Continue?')) return;
    try {
      await db.importAll(JSON.parse(await file.text()));
      settings = await db.getSettings();
      toast('Backup loaded');
      updateStreakPill();
      location.hash = '#/';
    } catch (err) { toast(err.message || 'That file could not be read'); }
  };
}


// ---------- Start ----------

(async function start() {
  settings = await db.getSettings();
  updateStreakPill();
  window.addEventListener('hashchange', render);
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // Load the PDF reader in the background once, so a list can be added even when offline later.
  if (navigator.onLine) setTimeout(() => import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs')
    .then(() => fetch('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs')).catch(() => {}), 4000);
})();
