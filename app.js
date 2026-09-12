/**
 * Voice Typing Notepad - everything that runs on the page.
 *
 * No framework and no server, on purpose: the whole thing is a folder that gets uploaded to
 * a host. Notes are in localStorage, recognition is Chrome's Web Speech API, and the parts
 * that decide what the text looks like - punctuation words, spacing, sentence casing,
 * "scratch that" - are the extension's own lib files, copied in by the build script.
 *
 * The one thing borrowed from the extension's panel rather than its libs is the discipline
 * about focus: every control does preventDefault on mousedown, so clicking the microphone
 * button never moves the caret out of the note.
 */

(() => {
  const Commands = globalThis.VoiceTypeCommands;
  const Targets = globalThis.VoiceTypeTargets;
  const Cue = globalThis.VoiceTypeCue;
  const LANGUAGES = globalThis.VoiceTypeLanguages || [];

  const $ = (id) => document.getElementById(id);

  // Where "Get the extension" points. One place to change when the store listing goes
  // live - every link on the page reads it from here.
  const EXTENSION_URL = 'https://getvoicetyping.com/';
  for (const a of document.querySelectorAll('.ext-link')) a.href = EXTENSION_URL;

  /* ---------- storage ----------
   *
   * One key holds everything, as JSON. Small enough that rewriting it on every change is
   * fine, and one key means one thing to export or clear.
   */
  const STORE_KEY = 'voiceTypingNotepad';

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const data = raw ? JSON.parse(raw) : null;
      if (data && Array.isArray(data.notes)) return data;
    } catch {
      // Corrupt or blocked storage: start fresh rather than refuse to open.
    }
    return { notes: [], currentId: null, lang: 'en-US', recent: [], words: {}, sound: true, theme: 'system' };
  }

  const state = load();
  if (!Array.isArray(state.recent)) state.recent = [];
  if (!state.words) state.words = {};
  if (typeof state.sound !== 'boolean') state.sound = true;
  if (!state.theme) state.theme = 'system';

  let saveTimer;
  function save(now) {
    clearTimeout(saveTimer);
    const write = () => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* quota or private mode */ }
    };
    if (now) write(); else saveTimer = setTimeout(write, 300);
  }

  /* ---------- notes ---------- */

  const editor = $('editor');
  const titleInput = $('title');
  const notesList = $('notes');
  const searchInput = $('search');

  const now = () => Date.now();
  const newId = () => Math.random().toString(36).slice(2, 10) + now().toString(36);

  function current() {
    return state.notes.find((n) => n.id === state.currentId) || null;
  }

  function createNote() {
    const note = { id: newId(), title: '', text: '', created: now(), updated: now() };
    state.notes.unshift(note);
    state.currentId = note.id;
    save(true);
    render();
    editor.focus();
    return note;
  }

  function deleteCurrent() {
    const note = current();
    if (note) deleteNote(note);
  }

  function titleOf(note) {
    if (note.title.trim()) return note.title.trim();
    const first = (note.text || '').split('\n').map((l) => l.trim()).find(Boolean);
    return first ? first.slice(0, 60) : 'Untitled note';
  }

  function when(ts) {
    const d = new Date(ts);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // Favourites sit above the rest, each group newest first. A starred note edited long ago
  // still outranks an unstarred one from a minute ago: starring is the user saying "keep
  // this within reach", and that outweighs recency.
  function sorted(notes) {
    return notes.slice().sort((a, b) => (Boolean(b.starred) - Boolean(a.starred)) || (b.updated - a.updated));
  }

  function starMark() {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'star');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M12 3l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.8 6.1 21l1.2-6.5L2.5 9.9 9.1 9z');
    s.appendChild(p);
    return s;
  }

  function renderList() {
    const q = searchInput.value.trim().toLowerCase();
    notesList.textContent = '';
    let shown = sorted(state.notes).filter((n) => !q || titleOf(n).toLowerCase().includes(q) || (n.text || '').toLowerCase().includes(q));
    if (state.filter === 'starred') shown = shown.filter((n) => n.starred);
    $('filterAll').classList.toggle('primary', state.filter !== 'starred');
    $('filterStarred').classList.toggle('primary', state.filter === 'starred');
    if (shown.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = q ? 'Nothing matches.'
        : state.filter === 'starred' ? 'No favourites yet. Press the star on a note to keep it here.'
        : 'No notes yet. Press + to start one.';
      notesList.appendChild(empty);
      return;
    }
    for (const note of shown) {
      // A div acting as a button, not a <button>: the row carries two real buttons of its
      // own (star, delete), and a button inside a button is invalid HTML that browsers
      // untangle unpredictably.
      const row = document.createElement('div');
      row.className = 'note' + (note.id === state.currentId ? ' current' : '');
      row.setAttribute('role', 'button');
      row.tabIndex = 0;

      const body = document.createElement('div');
      body.className = 'note-body';
      const t = document.createElement('div');
      t.className = 't';
      if (note.starred) t.appendChild(starMark());
      t.appendChild(document.createTextNode(titleOf(note)));
      const m = document.createElement('div');
      m.className = 'm';
      const words = (note.text || '').trim().split(/\s+/).filter(Boolean).length;
      m.textContent = `${when(note.updated)} · ${words} ${words === 1 ? 'word' : 'words'}`;
      body.append(t, m);

      const actions = document.createElement('div');
      actions.className = 'note-actions';
      const starBtn = iconButton(
        note.starred ? 'Remove from favourites' : 'Add to favourites',
        'M12 3l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.8 6.1 21l1.2-6.5L2.5 9.9 9.1 9z',
        () => { note.starred = !note.starred; save(true); render(); },
      );
      if (note.starred) starBtn.classList.add('on');
      const delBtn = iconButton('Delete note',
        'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
        () => deleteNote(note));
      actions.append(starBtn, delBtn);

      const open = () => {
        state.currentId = note.id;
        save(true);
        render();
        closeSide();
      };
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
      row.append(body, actions);
      notesList.appendChild(row);
    }
  }

  /** A small icon button for a list row. Clicks stop at the button, not the row under it. */
  function iconButton(label, path, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'row-btn';
    b.title = label;
    b.setAttribute('aria-label', label);
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'ico');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path);
    s.appendChild(p);
    b.appendChild(s);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function deleteNote(note) {
    if (!confirm('Delete this note? This cannot be undone.')) return;
    state.notes = state.notes.filter((n) => n.id !== note.id);
    if (state.currentId === note.id) state.currentId = sorted(state.notes)[0] ? sorted(state.notes)[0].id : null;
    save(true);
    render();
  }

  function renderEditor() {
    const note = current();
    titleInput.value = note ? note.title : '';
    // textContent, not innerHTML: notes are plain text, and a note that once contained
    // "<script>" must stay text.
    editor.textContent = note ? note.text : '';
    titleInput.disabled = !note;
    editor.contentEditable = note ? 'true' : 'false';
    $('copy').disabled = !note;
    $('download').disabled = !note;
    $('delete').disabled = !note;
    const star = $('star');
    star.disabled = !note;
    star.classList.toggle('on', Boolean(note && note.starred));
    star.setAttribute('aria-pressed', note && note.starred ? 'true' : 'false');
    star.title = note && note.starred ? 'Remove from favourites' : 'Add to favourites';
    updateCounts();
  }

  function render() {
    renderList();
    renderEditor();
  }

  function updateCounts() {
    const text = editor.innerText || '';
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    $('counts').textContent = `${words} ${words === 1 ? 'word' : 'words'} · ${text.length} chars`;
  }

  /** Pulls the editor's text back into the note. Called on every edit, debounced by save(). */
  function syncFromEditor() {
    const note = current();
    if (!note) return;
    note.text = editor.innerText.replace(/\n$/, '');
    note.title = titleInput.value;
    note.updated = now();
    save();
    updateCounts();
    // Re-sorting on every keystroke would make the list jump under the cursor; only the
    // title and timestamp of the current entry are refreshed.
    const row = notesList.querySelector('.note.current');
    if (row) {
      const t = row.querySelector('.t');
      t.textContent = '';
      if (note.starred) t.appendChild(starMark());
      t.appendChild(document.createTextNode(titleOf(note)));
      const words = note.text.trim().split(/\s+/).filter(Boolean).length;
      row.querySelector('.m').textContent = `${when(note.updated)} · ${words} ${words === 1 ? 'word' : 'words'}`;
    }
  }

  editor.addEventListener('input', syncFromEditor);
  titleInput.addEventListener('input', syncFromEditor);
  searchInput.addEventListener('input', renderList);
  $('newNote').addEventListener('click', createNote);
  $('delete').addEventListener('click', deleteCurrent);
  $('star').addEventListener('click', () => {
    const note = current();
    if (!note) return;
    note.starred = !note.starred;
    save(true);
    render();
  });
  $('filterAll').addEventListener('click', () => { state.filter = 'all'; save(true); renderList(); });
  $('filterStarred').addEventListener('click', () => { state.filter = 'starred'; save(true); renderList(); });

  // Paste as plain text: the editor holds text, and pasted HTML would bring in fonts and
  // colours that do not belong to the note.
  editor.addEventListener('paste', (event) => {
    event.preventDefault();
    const text = (event.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  /* ---------- copy and download ---------- */

  $('copy').addEventListener('click', async () => {
    const note = current();
    if (!note) return;
    const text = editor.innerText;
    let done = false;
    try { await navigator.clipboard.writeText(text); done = true; } catch { /* fall back below */ }
    if (!done) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      try { done = document.execCommand('copy'); } catch { done = false; }
      sel.removeAllRanges();
    }
    flash(done ? 'Copied' : 'Could not copy — select the text and press Ctrl+C');
  });

  $('download').addEventListener('click', () => {
    const note = current();
    if (!note) return;
    const blob = new Blob([editor.innerText], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${titleOf(note).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'note'}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  /* ---------- status strip ---------- */

  const live = $('live');
  let flashTimer;

  function setLive(text, kind) {
    clearTimeout(flashTimer);
    live.textContent = text || '';
    live.className = 'live' + (kind ? ' ' + kind : '');
  }

  function flash(text, kind) {
    setLive(text, kind);
    flashTimer = setTimeout(() => setLive(''), 2600);
  }

  /* ---------- languages ---------- */

  const langSelect = $('lang');
  const cmdLangSelect = $('cmdLang');

  function fillLanguages(select, includeRecent) {
    select.textContent = '';
    const recent = includeRecent ? state.recent.filter((c) => LANGUAGES.some((l) => l.code === c)).slice(0, 3) : [];
    if (recent.length) {
      const group = document.createElement('optgroup');
      group.label = 'Recent';
      for (const code of recent) {
        const l = LANGUAGES.find((x) => x.code === code);
        const o = document.createElement('option');
        o.value = l.code; o.textContent = l.label;
        group.appendChild(o);
      }
      select.appendChild(group);
    }
    const all = document.createElement('optgroup');
    all.label = recent.length ? 'All languages' : 'Languages';
    for (const l of LANGUAGES) {
      const o = document.createElement('option');
      o.value = l.code; o.textContent = l.label;
      all.appendChild(o);
    }
    select.appendChild(all);
    select.value = state.lang;
  }

  function noteLangUsed(code) {
    state.lang = code;
    state.recent = [code, ...state.recent.filter((c) => c !== code)].slice(0, 8);
    save(true);
  }

  langSelect.addEventListener('change', () => {
    noteLangUsed(langSelect.value);
    fillLanguages(langSelect, true);
    if (listening) restartRecognition();
  });

  const prefixOf = (code) => String(code).slice(0, 2).toLowerCase();

  /** The words in force for a language: the user's, or the built-in table, or nothing. */
  function wordsFor(code) {
    const mine = state.words[prefixOf(code)];
    return mine && Object.keys(mine).length ? mine : undefined;
  }

  /* ---------- spoken punctuation settings ---------- */

  function renderCommandRows() {
    const code = cmdLangSelect.value;
    const words = wordsFor(code) || Commands.defaultWords(code);
    const rows = $('cmdRows');
    rows.textContent = '';
    for (const slot of Commands.SLOTS) {
      const row = document.createElement('div');
      row.className = 'cmd-row';
      const mark = document.createElement('span'); mark.className = 'cmd-mark'; mark.textContent = slot.shows;
      const name = document.createElement('span'); name.className = 'cmd-name'; name.textContent = slot.label;
      const input = document.createElement('input');
      input.type = 'text'; input.value = words[slot.id] || ''; input.placeholder = 'not set';
      input.dataset.slot = slot.id;
      input.addEventListener('change', saveWords);
      row.append(mark, name, input);
      rows.appendChild(row);
    }
  }

  function saveWords() {
    const words = {};
    for (const input of $('cmdRows').querySelectorAll('input')) {
      const v = input.value.trim();
      if (v) words[input.dataset.slot] = v;
    }
    state.words[prefixOf(cmdLangSelect.value)] = words;
    save(true);
    flash('Saved');
  }

  cmdLangSelect.addEventListener('change', renderCommandRows);
  $('cmdReset').addEventListener('click', () => {
    delete state.words[prefixOf(cmdLangSelect.value)];
    save(true);
    renderCommandRows();
    flash('Back to the built-in words');
  });

  /* ---------- settings sheet, theme, sound ---------- */

  const sheet = $('sheet');
  const sheetBack = $('sheetBack');
  /**
   * Both menu entries open the same sheet; the argument only decides which section is
   * scrolled into view. One sheet rather than two, so there is one place to close.
   */
  function openSheet(which) {
    // Two different panels sharing one drawer, not one long page with two halves: asked
    // for on 2026-09-12. Punctuation shows nothing but the words; Settings shows nothing
    // but the settings.
    const words = which === 'sheetWords';
    $('sheetWords').hidden = !words;
    $('sheetSettings').hidden = words;
    $('sheetTitle').textContent = words ? 'Spoken punctuation' : 'Settings';
    if (words) {
      cmdLangSelect.value = state.lang;
      renderCommandRows();
    }
    sheet.classList.add('open'); sheetBack.classList.add('open');
    sheet.querySelector('.sbody').scrollTop = 0;
    closeSide();
  }
  function closeSheet() { sheet.classList.remove('open'); sheetBack.classList.remove('open'); }
  $('menuWords').addEventListener('click', () => openSheet('sheetWords'));
  $('menuSettings').addEventListener('click', () => openSheet('sheetSettings'));
  $('closeSheet').addEventListener('click', closeSheet);
  sheetBack.addEventListener('click', closeSheet);

  function applyTheme() {
    if (state.theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', state.theme);
    for (const b of document.querySelectorAll('[data-theme]')) {
      if (b.tagName === 'BUTTON') b.classList.toggle('primary', b.dataset.theme === state.theme);
    }
  }
  for (const b of document.querySelectorAll('.theme-row [data-theme]')) {
    b.addEventListener('click', () => { state.theme = b.dataset.theme; save(true); applyTheme(); });
  }

  const soundOn = $('soundOn');
  soundOn.checked = state.sound;
  soundOn.addEventListener('change', () => { state.sound = soundOn.checked; save(true); });

  /* ---------- side drawer on small screens ---------- */

  const side = $('side');
  $('menuBtn').addEventListener('click', () => side.classList.toggle('open'));
  function closeSide() { side.classList.remove('open'); }
  document.addEventListener('click', (e) => {
    if (side.classList.contains('open') && !side.contains(e.target) && e.target !== $('menuBtn') && !$('menuBtn').contains(e.target)) closeSide();
  });

  /* ---------- keep the caret in the note ----------
   *
   * Every control the user clicks while dictating must not take focus: the next phrase is
   * inserted at the caret, and a caret that just left the editor would drop the phrase on
   * the button instead. Same rule the extension's panel lives by.
   */
  for (const el of document.querySelectorAll('.bar button, .bar select, .side button')) {
    el.addEventListener('mousedown', (e) => { if (el.tagName === 'BUTTON') e.preventDefault(); });
  }

  /* ---------- dictation ---------- */

  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recBtn = $('rec');
  const recLabel = $('recLabel');
  let recognition = null;
  let listening = false;
  let cued = false;

  // The extension's own insertion target, pointed at the editor. It reads the text around
  // the caret for spacing and casing and remembers what it typed for "scratch that".
  const saved = { el: editor, start: null, end: null, range: null };
  const target = Targets.createDomTarget(saved);

  if (!Rec) {
    $('noApi').hidden = false;
    recBtn.disabled = true;
  }

  function setListening(on) {
    listening = on;
    recBtn.classList.toggle('on', on);
    recBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    recLabel.textContent = on ? 'Stop' : 'Start dictation';
    // Only the start message lives here. Clearing on stop is stopRecognition's decision,
    // because an error that stopped dictation has to stay on screen to be read - the first
    // version wiped it in the same breath it was shown.
    if (on) setLive('Start speaking');
  }

  function cue(kind) {
    if (!state.sound || !Cue) return;
    Cue.play(kind);
  }

  function startRecognition() {
    if (!Rec || listening) return;
    if (!current()) createNote();
    editor.focus();

    const r = new Rec();
    r.lang = state.lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart = () => {
      if (!cued) { cued = true; cue('start'); }
    };

    r.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const res = event.results[i];
        const text = res[0].transcript;
        if (res.isFinal) handleFinal(text);
        else interim += text;
      }
      if (interim.trim()) {
        setLive(Commands.applyCommands(interim, {
          lang: state.lang, words: wordsFor(state.lang), startsSentence: target.startsSentence(),
        }));
      }
    };

    r.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      const known = {
        'not-allowed': 'Microphone access is blocked for this site',
        'audio-capture': 'No microphone found',
        'network': 'Cannot reach the speech service — check the connection',
        'service-not-allowed': 'Speech recognition is unavailable in this browser',
        'language-not-supported': 'Chrome cannot recognize this language — pick another',
      };
      setLive(known[event.error] || `Recognition error: ${event.error}`, 'err');
      if (event.error === 'not-allowed') $('micBlocked').hidden = false;
      if (event.error !== 'network') stopRecognition(true);
    };

    r.onend = () => {
      // Chrome ends a continuous session on its own after silence; while the user still
      // wants to dictate, start it again without ceremony.
      if (listening && recognition === r) {
        try { r.start(); } catch { stopRecognition(); }
      }
    };

    recognition = r;
    setListening(true);
    try {
      r.start();
    } catch (error) {
      setLive(`Could not start: ${error.message}`, 'err');
      setListening(false);
      recognition = null;
    }
  }

  function stopRecognition(keepMessage) {
    const r = recognition;
    recognition = null;
    setListening(false);
    if (!keepMessage) setLive('');
    if (r) {
      r.onend = null;
      try { r.stop(); } catch { /* already stopped */ }
    }
    if (cued) { cued = false; cue('stop'); }
    syncFromEditor();
  }

  function restartRecognition() {
    stopRecognition();
    startRecognition();
  }

  function handleFinal(raw) {
    const words = wordsFor(state.lang);

    // "scratch that" and friends: an action, not text. Whatever preceded it in the same
    // breath was retracted and is never typed.
    const action = Commands.matchAction(raw, state.lang, words);
    if (action) {
      if (action.rest) insertText(action.rest);
      const outcome = target.deleteLast();
      flash(outcome === 'ok' ? 'Removed the last phrase'
        : outcome === 'nothing' ? 'Nothing dictated yet to remove'
        : 'That text has changed since — nothing removed');
      return;
    }
    insertText(raw);
    setLive('');
  }

  function insertText(raw) {
    const text = Commands.applyCommands(raw, {
      lang: state.lang, words: wordsFor(state.lang), startsSentence: target.startsSentence(),
    });
    if (!text) return;
    // The target reads the live selection inside the editor. If it wandered (a click on a
    // control that did not prevent it), put the caret at the end rather than losing text.
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !editor.contains(sel.getRangeAt(0).startContainer)) {
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel.removeAllRanges(); sel.addRange(range);
    }
    target.insert(text);
    syncFromEditor();
    editor.scrollIntoView({ block: 'nearest' });
  }

  recBtn.addEventListener('click', () => (listening ? stopRecognition() : startRecognition()));

  /*
   * Ctrl+Q, the same key as the extension - and Ctrl+Shift+D kept as a second one.
   *
   * Why a page cannot simply promise Ctrl+Q: an extension registers its shortcut with the
   * browser, which handles it before any page sees it. A page only gets the keys the
   * browser does not keep for itself, and on Linux Chrome keeps Ctrl+Q for quitting (with a
   * "press again to quit" warning). So Ctrl+Q works here on Windows and on a Mac, where
   * Ctrl is not Cmd; on Linux the browser answers first. Ctrl+Shift+D is the one no
   * browser claims, and it is here for exactly that case.
   */
  document.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    const toggle = (event.ctrlKey && !event.shiftKey && !event.altKey && key === 'q')
      || (event.ctrlKey && event.shiftKey && key === 'd');
    if (toggle) {
      event.preventDefault();
      if (listening) stopRecognition(); else startRecognition();
    }
    if (event.key === 'Escape' && listening) stopRecognition();
  });

  // Leaving the page must not leave a microphone open.
  window.addEventListener('pagehide', () => { if (listening) stopRecognition(); });

  /* ---------- boot ---------- */

  $('year').textContent = String(new Date().getFullYear());
  applyTheme();
  fillLanguages(langSelect, true);
  fillLanguages(cmdLangSelect, false);
  // The editor lives in the sheet and is filled when the sheet opens, on the language being
  // dictated. Filled once here too, so a test - or a user - reaching it before opening the
  // sheet sees the right words.
  cmdLangSelect.value = state.lang;
  renderCommandRows();
  langSelect.addEventListener('change', () => { cmdLangSelect.value = state.lang; renderCommandRows(); });

  // Chrome cannot remember permissions for a file:// address, so it asks for the microphone
  // on every start there. That is the address the page is opened from while it is being
  // looked at before upload, and without this line it looks like a bug in the page.
  if (location.protocol === 'file:') $('fileOrigin').hidden = false;

  if (state.notes.length === 0) {
    const first = { id: newId(), title: '', text: '', created: now(), updated: now() };
    state.notes.push(first);
    state.currentId = first.id;
    save(true);
  } else if (!current()) {
    state.currentId = state.notes[0].id;
  }
  render();
})();
