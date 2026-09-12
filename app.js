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
  if (!Array.isArray(state.folders)) state.folders = [];
  if (typeof state.hotkey !== 'string') state.hotkey = 'Ctrl+Q';
  if (!Array.isArray(state.trash)) state.trash = [];
  if (!Array.isArray(state.openFolders)) state.openFolders = [];
  // The folder-as-filter view is gone; a saved one falls back to the full list.
  if (typeof state.filter === 'string' && state.filter.startsWith('folder:')) state.filter = 'all';

  let saveTimer;
  function save(now) {
    clearTimeout(saveTimer);
    const write = () => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(state));
        $('storageFull').hidden = true;
      } catch {
        // Quota, or a browser that blocks storage. Said out loud: the first version swallowed
        // this, and a full store would have looked like a page that simply forgets.
        $('storageFull').hidden = false;
      }
      scheduleAutoBackup();
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
    return state.notes.find((n) => n.id === state.currentId)
      || state.trash.find((n) => n.id === state.currentId) || null;
  }

  /**
   * @param {string} [folderId] - "New note here" in a folder's menu. Otherwise the note
   *   lands in the folder of the note being looked at, so working inside a folder stays
   *   inside it; with no folder open it lands among the loose notes.
   */
  function createNote(folderId) {
    const note = { id: newId(), title: '', text: '', created: now(), updated: now() };
    const here = current();
    const target = typeof folderId === 'string' ? folderId : (here && !inTrash(here) && here.folder && folderOf(here.folder) ? here.folder : null);
    if (target) { note.folder = target; setOpen(target, true); }
    // Made while looking at Recently deleted, the view goes back to the list, where the note is.
    if (state.filter === 'trash') state.filter = 'all';
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

  /* ---------- folders ----------
   *
   * A folder is a name with an id; a note carries the id of the folder it is in, or none.
   * Folders are a tree at the top of the list: a folder opens in place and shows its notes
   * under it (state.openFolders remembers which are open), and the notes in no folder
   * follow under their own heading. Nothing is ever filtered away by a folder - the first
   * version did that, and a freshly made folder left the list looking empty.
   */

  function folderOf(id) {
    return state.folders.find((f) => f.id === id) || null;
  }

  function notesIn(folderId) {
    return sorted(state.notes.filter((n) => (folderId ? n.folder === folderId : !n.folder || !folderOf(n.folder))));
  }

  function isOpen(folderId) {
    return state.openFolders.includes(folderId);
  }

  function setOpen(folderId, open) {
    state.openFolders = state.openFolders.filter((id) => id !== folderId);
    if (open) state.openFolders.push(folderId);
  }

  function createFolder(name) {
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) return null;
    const folder = { id: newId(), name: clean };
    state.folders.push(folder);
    setOpen(folder.id, true);
    save(true);
    return folder;
  }

  /** "+ New" above the list: the folder appears, open and empty, and nothing else moves. */
  function askNewFolder() {
    const folder = createFolder(prompt('Folder name'));
    if (!folder) return null;
    renderList();
    renderFolderSelect();
    flash(`Folder "${folder.name}" created — add notes to it from a note's ⋮ menu`);
    return folder;
  }

  function renameFolder(folder) {
    const name = prompt('Rename folder', folder.name);
    if (name === null) return;
    const clean = name.trim().slice(0, 60);
    if (!clean) return;
    folder.name = clean;
    save(true);
    render(false);
  }

  /** The folder goes; its notes stay, back among the notes in no folder. */
  function deleteFolder(folder) {
    const inside = state.notes.filter((n) => n.folder === folder.id).length;
    const what = inside ? ` Its ${inside} ${inside === 1 ? 'note stays' : 'notes stay'} in the list.` : '';
    if (!confirm(`Delete the folder "${folder.name}"?${what}`)) return;
    state.folders = state.folders.filter((f) => f.id !== folder.id);
    for (const n of state.notes) if (n.folder === folder.id) delete n.folder;
    setOpen(folder.id, false);
    save(true);
    render(false);
  }

  function moveToFolder(note, folderId) {
    if (folderId) { note.folder = folderId; setOpen(folderId, true); } else delete note.folder;
    save(true);
    renderList();
    renderFolderSelect();
    flash(folderId ? `Moved to "${folderOf(folderId).name}"` : 'Taken out of its folder');
  }

  /** The box next to the title: which folder the note is in, and a way to make a new one. */
  function renderFolderSelect() {
    const sel = $('folderSel');
    const note = current();
    sel.textContent = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'No folder';
    sel.appendChild(none);
    for (const f of state.folders) {
      const o = document.createElement('option');
      o.value = f.id;
      o.textContent = f.name;
      sel.appendChild(o);
    }
    const make = document.createElement('option');
    make.value = '__new__';
    make.textContent = 'New folder…';
    sel.appendChild(make);
    sel.value = note && note.folder && folderOf(note.folder) ? note.folder : '';
    sel.disabled = !note || inTrash(note);
  }

  $('folderSel').addEventListener('change', () => {
    const note = current();
    const sel = $('folderSel');
    if (!note) return;
    if (sel.value === '__new__') {
      const folder = createFolder(prompt('Folder name'));
      if (folder) moveToFolder(note, folder.id);
      else renderFolderSelect();
      return;
    }
    moveToFolder(note, sel.value || null);
  });

  /* ---------- the row menu ----------
   *
   * One popover for every ⋮ in the list. It is built from a list of items each time, sits
   * under the button that opened it, and goes on any click outside, on Esc, or when the
   * list is drawn again. "Add to folder" swaps the items for the folder list in place.
   */

  const pop = $('pop');
  let popAnchor = null;

  function closeMenu() {
    if (pop.hidden) return;
    pop.hidden = true;
    pop.textContent = '';
    const row = popAnchor && popAnchor.closest('.note, .folder');
    if (row) row.classList.remove('menu-open');
    popAnchor = null;
  }

  /**
   * @param {HTMLElement} anchor - the ⋮ button.
   * @param {Array<{label?: string, icon?: string, danger?: boolean, checked?: boolean, title?: string, sep?: boolean, onClick?: Function}>} items
   */
  function openMenu(anchor, items) {
    closeMenu();
    popAnchor = anchor;
    const row = anchor.closest('.note, .folder');
    if (row) row.classList.add('menu-open');
    fillMenu(items);
    pop.hidden = false;
    placeMenu();
    const first = pop.querySelector('button');
    if (first) first.focus();
  }

  function placeMenu() {
    if (!popAnchor) return;
    const r = popAnchor.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left = Math.min(r.right - w, window.innerWidth - w - 8);
    if (left < 8) left = 8;
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function fillMenu(items) {
    pop.textContent = '';
    for (const item of items) {
      if (item.sep) { const s = document.createElement('div'); s.className = 'pop-sep'; pop.appendChild(s); continue; }
      if (item.title) { const t = document.createElement('div'); t.className = 'pop-title'; t.textContent = item.title; pop.appendChild(t); continue; }
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      if (item.danger) b.classList.add('danger');
      if (item.checked) b.classList.add('checked');
      if (item.icon) {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        s.setAttribute('viewBox', '0 0 24 24');
        s.setAttribute('class', 'ico');
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', item.icon);
        s.appendChild(p);
        b.appendChild(s);
      }
      b.appendChild(document.createTextNode(item.label));
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        // An item may swap the menu's contents (a submenu) instead of closing it.
        const keep = item.onClick && item.onClick() === 'keep';
        if (!keep) closeMenu();
        else placeMenu();
      });
      pop.appendChild(b);
    }
  }

  document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { closeMenu(); e.stopPropagation(); } }, true);
  window.addEventListener('resize', closeMenu);

  const ICON = {
    star: 'M12 3l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.8 6.1 21l1.2-6.5L2.5 9.9 9.1 9z',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    folderPlus: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M12 10v6 M9 13h6',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    pencil: 'M4 20h4l10-10-4-4L4 16z M13 7l4 4',
    check: 'M5 12l5 5L20 7',
    back: 'M15 18l-6-6 6-6',
    dots: 'M12 5h.01M12 12h.01M12 19h.01',
    plus: 'M12 5v14M5 12h14',
  };

  function folderSubmenu(note) {
    const items = [{ title: 'Add to folder' }];
    for (const f of state.folders) {
      const here = note.folder === f.id;
      items.push({ label: f.name, icon: here ? ICON.check : ICON.folder, checked: here,
        onClick: () => { if (!here) moveToFolder(note, f.id); } });
    }
    if (note.folder && folderOf(note.folder)) {
      items.push({ label: 'Remove from folder', icon: ICON.back, onClick: () => moveToFolder(note, null) });
    }
    items.push({ sep: true });
    items.push({ label: 'New folder…', icon: ICON.folderPlus, onClick: () => {
      const folder = createFolder(prompt('Folder name'));
      if (folder) moveToFolder(note, folder.id);
    } });
    return items;
  }

  function noteMenu(anchor, note) {
    openMenu(anchor, [
      { label: note.starred ? 'Remove from favourites' : 'Add to favourites', icon: ICON.star,
        onClick: () => { note.starred = !note.starred; save(true); renderList(); renderStar(); } },
      { label: 'Add to folder…', icon: ICON.folder, onClick: () => { fillMenu(folderSubmenu(note)); return 'keep'; } },
      { sep: true },
      { label: 'Delete', icon: ICON.trash, danger: true, onClick: () => deleteNote(note) },
    ]);
  }

  function folderMenu(anchor, folder) {
    openMenu(anchor, [
      { label: 'New note here', icon: ICON.plus, onClick: () => createNote(folder.id) },
      { label: 'Rename', icon: ICON.pencil, onClick: () => renameFolder(folder) },
      { sep: true },
      { label: 'Delete folder', icon: ICON.trash, danger: true, onClick: () => deleteFolder(folder) },
    ]);
  }

  /* ---------- the list ---------- */

  function sectionHead(text, button) {
    const head = document.createElement('div');
    head.className = 'list-head';
    head.append(document.createTextNode(text));
    if (button) head.appendChild(button);
    return head;
  }

  function noteRow(note, opts = {}) {
    // A div acting as a button, not a <button>: the row carries a real button of its own
    // (the ⋮ menu), and a button inside a button is invalid HTML that browsers untangle
    // unpredictably.
    const row = document.createElement('div');
    row.className = 'note' + (note.id === state.currentId ? ' current' : '') + (opts.indent ? ' in-folder' : '');
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
    // Where the row is not already under its folder, it names the folder.
    if (opts.showFolder && note.folder && folderOf(note.folder)) m.textContent += ` · ${folderOf(note.folder).name}`;
    body.append(t, m);

    const actions = document.createElement('div');
    actions.className = 'note-actions';
    const more = iconButton('More', ICON.dots, () => noteMenu(more, note));
    actions.append(more);

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
    return row;
  }

  function folderRow(folder) {
    const row = document.createElement('div');
    const open = isOpen(folder.id);
    row.className = 'folder' + (open ? ' open' : '');
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', open ? 'true' : 'false');
    row.tabIndex = 0;
    const svg = (cls, d) => {
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('viewBox', '0 0 24 24');
      s.setAttribute('class', cls);
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
      return s;
    };
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = folder.name;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(notesIn(folder.id).length);
    const actions = document.createElement('div');
    actions.className = 'note-actions';
    const more = iconButton('Folder menu', ICON.dots, () => folderMenu(more, folder));
    actions.append(more);
    const toggle = () => { setOpen(folder.id, !isOpen(folder.id)); save(true); renderList(); };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    row.append(svg('ico chev', 'M9 6l6 6-6 6'), svg('ico', ICON.folder), name, count, actions);
    return row;
  }

  function renderList() {
    closeMenu();
    const q = searchInput.value.trim().toLowerCase();
    notesList.textContent = '';
    $('filterAll').classList.toggle('primary', state.filter !== 'starred' && state.filter !== 'trash');
    $('filterStarred').classList.toggle('primary', state.filter === 'starred');
    $('menuTrash').classList.toggle('on', state.filter === 'trash');
    if (state.filter === 'trash') { renderTrashList(q); return; }

    const matches = (n) => !q || titleOf(n).toLowerCase().includes(q) || (n.text || '').toLowerCase().includes(q);
    const empty = (text) => {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = text;
      notesList.appendChild(e);
    };

    // A search or Favourites: one flat list, every note saying where it lives.
    if (q || state.filter === 'starred') {
      const shown = sorted(state.notes).filter(matches).filter((n) => state.filter !== 'starred' || n.starred);
      if (shown.length === 0) {
        empty(q ? 'Nothing matches.' : 'No favourites yet. Star a note to keep it here.');
        return;
      }
      for (const note of shown) notesList.appendChild(noteRow(note, { showFolder: true }));
      return;
    }

    // Everything: the folders as a tree, then the notes in no folder.
    const add = document.createElement('button');
    add.type = 'button';
    add.id = 'newFolder';
    add.textContent = '+ New';
    add.title = 'New folder';
    add.addEventListener('click', askNewFolder);
    notesList.appendChild(sectionHead('Folders', add));
    if (state.folders.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'folder-empty';
      hint.style.marginLeft = '8px';
      hint.textContent = 'No folders yet.';
      notesList.appendChild(hint);
    }
    for (const folder of state.folders) {
      notesList.appendChild(folderRow(folder));
      if (!isOpen(folder.id)) continue;
      const inside = notesIn(folder.id);
      if (inside.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'folder-empty';
        hint.textContent = 'Empty — add a note from its ⋮ menu, or "New note here" in the folder menu.';
        notesList.appendChild(hint);
      }
      for (const note of inside) notesList.appendChild(noteRow(note, { indent: true }));
    }

    const loose = notesIn(null);
    notesList.appendChild(sectionHead('Notes'));
    if (loose.length === 0) {
      empty(state.notes.length ? 'Every note is in a folder.' : 'No notes yet. Press New note to start one.');
      return;
    }
    for (const note of loose) notesList.appendChild(noteRow(note));
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

  /* ---------- recently deleted ----------
   *
   * Delete moves a note to state.trash, where it stays for 30 days and can be put back; a
   * confirmation dialog is no longer asked for, because nothing is lost yet. "Delete
   * forever" and "Empty" are the only irreversible steps, and those do ask.
   */

  const TRASH_DAYS = 30;

  function inTrash(note) {
    return Boolean(note) && state.trash.some((n) => n.id === note.id);
  }

  function purgeTrash() {
    const limit = now() - TRASH_DAYS * 24 * 60 * 60 * 1000;
    const before = state.trash.length;
    state.trash = state.trash.filter((n) => (n.deletedAt || 0) > limit);
    if (state.trash.length !== before) save(true);
  }

  function nextCurrentAfter(id) {
    if (state.currentId !== id) return;
    const pool = state.filter === 'trash' ? state.trash : state.notes;
    state.currentId = sorted(pool)[0] ? sorted(pool)[0].id : null;
  }

  function deleteNote(note) {
    state.notes = state.notes.filter((n) => n.id !== note.id);
    note.deletedAt = now();
    state.trash.unshift(note);
    nextCurrentAfter(note.id);
    save(true);
    render();
    flash('Moved to Recently deleted');
  }

  function restoreNote(note) {
    state.trash = state.trash.filter((n) => n.id !== note.id);
    delete note.deletedAt;
    if (note.folder && !folderOf(note.folder)) delete note.folder;
    state.notes.unshift(note);
    nextCurrentAfter(note.id);
    save(true);
    render();
    flash('Restored');
  }

  function destroyNote(note) {
    if (!confirm('Delete this note forever? It cannot be brought back.')) return;
    state.trash = state.trash.filter((n) => n.id !== note.id);
    nextCurrentAfter(note.id);
    save(true);
    render();
  }

  function emptyTrash() {
    if (!state.trash.length) return;
    if (!confirm(`Delete ${state.trash.length === 1 ? 'this note' : 'these ' + state.trash.length + ' notes'} forever?`)) return;
    const wasOpen = inTrash(current());
    state.trash = [];
    if (wasOpen) state.currentId = null;
    save(true);
    render();
  }

  function showTrash() {
    state.filter = 'trash';
    save(true);
    render(false);
    closeSide();
  }

  /** The list in Recently deleted: restore or destroy per row, empty it all at the top. */
  function renderTrashList(q) {
    const head = document.createElement('div');
    head.className = 'list-head';
    head.append(document.createTextNode('Recently deleted'));
    const empty = document.createElement('button');
    empty.type = 'button';
    empty.id = 'emptyTrash';
    empty.className = 'danger';
    empty.textContent = 'Empty';
    empty.hidden = state.trash.length === 0;
    empty.addEventListener('click', emptyTrash);
    head.appendChild(empty);
    notesList.appendChild(head);

    const shown = state.trash.slice().sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))
      .filter((n) => !q || titleOf(n).toLowerCase().includes(q) || (n.text || '').toLowerCase().includes(q));
    if (shown.length === 0) {
      const none = document.createElement('div');
      none.className = 'empty';
      none.textContent = q ? 'Nothing matches.' : `Nothing here. Deleted notes wait ${TRASH_DAYS} days before they go for good.`;
      notesList.appendChild(none);
      return;
    }
    for (const note of shown) {
      const row = document.createElement('div');
      row.className = 'note' + (note.id === state.currentId ? ' current' : '');
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      const body = document.createElement('div');
      body.className = 'note-body';
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = titleOf(note);
      const m = document.createElement('div');
      m.className = 'm';
      const daysLeft = Math.max(1, Math.ceil(((note.deletedAt || 0) + TRASH_DAYS * 86400000 - now()) / 86400000));
      m.textContent = `Deleted ${when(note.deletedAt || 0)} · ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left`;
      body.append(t, m);
      const actions = document.createElement('div');
      actions.className = 'note-actions';
      actions.append(
        iconButton('Restore', 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5', () => restoreNote(note)),
        iconButton('Delete forever', 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3', () => destroyNote(note)),
      );
      const open = () => { state.currentId = note.id; save(true); render(); closeSide(); };
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      row.append(body, actions);
      notesList.appendChild(row);
    }
  }

  /* ---------- what a note holds ----------
   *
   * Two copies of the body. `html` is what the editor shows - bold, headings, lists - and
   * `text` is the same thing flattened, kept for the list, the search and the word count so
   * none of them has to parse markup. Notes written before formatting existed have only
   * `text`; they are lifted to `html` the first time they are shown.
   */

  const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'H2', 'H3',
    'P', 'DIV', 'BR', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'SUB', 'SUP']);
  const DROPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'LINK', 'META']);

  /**
   * Markup is only ever written by this editor, but storage is readable and a restored backup
   * is a file anyone could have edited. So everything coming back in is reduced to the tags
   * the toolbar can make, with no attributes at all: a style, a class or an onclick has no
   * business in a note.
   */
  function sanitizeHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    const clean = (parent) => {
      for (const node of Array.from(parent.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) continue;
        if (node.nodeType !== Node.ELEMENT_NODE || DROPPED_TAGS.has(node.tagName)) { node.remove(); continue; }
        clean(node);
        if (ALLOWED_TAGS.has(node.tagName)) {
          for (const attr of Array.from(node.attributes)) node.removeAttribute(attr.name);
        } else {
          // Unknown tag: keep what it wraps, lose the wrapper.
          while (node.firstChild) parent.insertBefore(node.firstChild, node);
          node.remove();
        }
      }
    };
    clean(tpl.content);
    return tpl.innerHTML;
  }

  function textToHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text || '');
    return div.innerHTML.replace(/\n/g, '<br>');
  }

  function htmlOf(note) {
    return sanitizeHtml(typeof note.html === 'string' ? note.html : textToHtml(note.text));
  }

  /* ---------- where the caret was ----------
   *
   * The page remembers which note was open; it also has to remember where in it the person
   * was. A caret is stored as a count of characters from the start of the note - the one
   * measure that survives the markup around it and a reload.
   */

  function caretOffset() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.startContainer)) return null;
    const before = document.createRange();
    before.selectNodeContents(editor);
    before.setEnd(range.startContainer, range.startOffset);
    return before.toString().length;
  }

  function placeCaret(offset) {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    let remaining = Math.max(0, Number(offset) || 0);
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let placed = false;
    while (node) {
      if (remaining <= node.data.length) { range.setStart(node, remaining); placed = true; break; }
      remaining -= node.data.length;
      node = walker.nextNode();
    }
    if (!placed) { range.selectNodeContents(editor); range.collapse(false); }
    else range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  let caretTimer;
  document.addEventListener('selectionchange', () => {
    const note = current();
    if (!note) return;
    const offset = caretOffset();
    if (offset === null) return;
    note.caret = offset;
    // The selection moves on every arrow key; write it out unhurriedly.
    clearTimeout(caretTimer);
    caretTimer = setTimeout(() => save(), 400);
  });

  /**
   * @param {boolean} focus - put the caret back where it was in this note. True when a note
   *   is opened or the page comes up; false when only the buttons around it changed.
   */
  function renderEditor(focus) {
    const note = current();
    // A deleted note can be read and copied, not edited: Restore first.
    const editable = Boolean(note) && !inTrash(note);
    titleInput.value = note ? note.title : '';
    editor.innerHTML = note ? htmlOf(note) : '';
    titleInput.disabled = !editable;
    editor.contentEditable = editable ? 'true' : 'false';
    editor.classList.toggle('locked', Boolean(note) && !editable);
    $('copy').disabled = !note;
    $('download').disabled = !note;
    $('delete').disabled = !editable;
    for (const b of toolbar.querySelectorAll('.tb')) b.disabled = !editable;
    renderStar();
    renderFolderSelect();
    updateCounts();
    if (note && !editable) setLive('In Recently deleted — restore it to edit', 'hint');
    else if (/^In Recently deleted/.test(live.textContent)) setLive('');
    if (note && editable && focus) {
      editor.focus({ preventScroll: true });
      placeCaret(note.caret);
      updateToolbar();
    }
  }

  function renderStar() {
    const note = current();
    const star = $('star');
    star.disabled = !note || inTrash(note);
    star.classList.toggle('on', Boolean(note && note.starred));
    star.setAttribute('aria-pressed', note && note.starred ? 'true' : 'false');
    star.title = note && note.starred ? 'Remove from favourites' : 'Add to favourites';
  }

  function render(focus = true) {
    renderList();
    renderEditor(focus);
  }

  /* ---------- formatting ----------
   *
   * The browser's own editing commands, the way every notepad of this kind does it: they
   * keep the undo stack whole, so Ctrl+Z after a bold still works, and Ctrl+B / Ctrl+I /
   * Ctrl+U come for free. Block styles toggle: a heading pressed again becomes a paragraph.
   */

  const toolbar = $('toolbar');

  function caretInEditor() {
    const sel = window.getSelection();
    return Boolean(sel && sel.rangeCount > 0 && editor.contains(sel.getRangeAt(0).startContainer));
  }

  function currentBlock() {
    let value = '';
    try { value = String(document.queryCommandValue('formatBlock') || '').toLowerCase(); } catch { /* unsupported */ }
    return value;
  }

  function exec(command, value) {
    try { return document.execCommand(command, false, value); } catch { return false; }
  }

  function applyFormat(button) {
    if (!current()) return;
    if (!caretInEditor()) { editor.focus({ preventScroll: true }); placeCaret(current().caret); }
    const cmd = button.dataset.cmd;
    const block = button.dataset.block;
    if (cmd) {
      exec(cmd);
    } else if (block === 'blockquote') {
      // Chrome reports a quote's inner block, not the quote; ask the DOM instead.
      const sel = window.getSelection();
      let node = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
      let inQuote = false;
      while (node && node !== editor) { if (node.nodeName === 'BLOCKQUOTE') { inQuote = true; break; } node = node.parentNode; }
      if (inQuote) exec('outdent'); else exec('formatBlock', '<blockquote>');
    } else if (block) {
      exec('formatBlock', currentBlock() === block ? '<div>' : '<' + block + '>');
    }
    updateToolbar();
  }

  function updateToolbar() {
    const inside = caretInEditor();
    const block = inside ? currentBlock() : '';
    for (const b of toolbar.querySelectorAll('.tb')) {
      let on = false;
      if (inside && b.dataset.cmd && /^(bold|italic|underline|strikeThrough|insertUnorderedList|insertOrderedList)$/.test(b.dataset.cmd)) {
        try { on = document.queryCommandState(b.dataset.cmd); } catch { on = false; }
      } else if (inside && b.dataset.block) {
        if (b.dataset.block === 'blockquote') {
          const sel = window.getSelection();
          let node = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
          while (node && node !== editor) { if (node.nodeName === 'BLOCKQUOTE') { on = true; break; } node = node.parentNode; }
        } else on = block === b.dataset.block;
      }
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  for (const b of toolbar.querySelectorAll('.tb')) {
    // mousedown is refused so the selection in the note survives the click.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => applyFormat(b));
  }
  document.addEventListener('selectionchange', () => { if (caretInEditor()) updateToolbar(); });

  function updateCounts() {
    const text = editor.innerText || '';
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    $('counts').textContent = `${words} ${words === 1 ? 'word' : 'words'} · ${text.length} chars`;
  }

  /** Pulls the editor's text back into the note. Called on every edit, debounced by save(). */
  function syncFromEditor() {
    const note = current();
    if (!note || inTrash(note)) return;
    note.text = editor.innerText.replace(/\n$/, '');
    note.html = editor.innerHTML;
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
    // The list re-sorts; the editor is left alone so the caret stays where it is.
    renderList();
    renderStar();
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
    // Both flavours go on the clipboard: an editor that understands HTML (Docs, Gmail) keeps
    // the bold and the lists, a plain field gets the text.
    try {
      if (window.ClipboardItem && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([editor.innerHTML], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        })]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      done = true;
    } catch { /* fall back below */ }
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
    downloadFile(`${titleOf(note).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'note'}.txt`,
      editor.innerText, 'text/plain;charset=utf-8');
  });

  /* ---------- backup and restore ----------
   *
   * There is no account, so the browser's storage is the only copy of every note. A backup
   * is that copy as a file. Restoring MERGES: a note the file has and the page does not is
   * added; a note both have is taken from whichever was edited later; nothing here is ever
   * deleted by a restore. That makes restoring safe to do twice, and safe to do on a second
   * computer that already has notes of its own.
   */

  const BACKUP_KIND = 'voice-typing-notepad-backup';

  function downloadFile(name, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function makeBackup() {
    return {
      kind: BACKUP_KIND,
      version: 1,
      exported: new Date().toISOString(),
      notes: state.notes,
      folders: state.folders,
      trash: state.trash,
      words: state.words,
    };
  }

  /**
   * @returns {{added: number, updated: number, kept: number, words: number}} what changed.
   * @throws {Error} with a message fit for the screen when the file is not a backup.
   */
  function restoreBackup(data) {
    if (!data || data.kind !== BACKUP_KIND || !Array.isArray(data.notes)) {
      throw new Error('This is not a Voice Typing Notepad backup file.');
    }
    let added = 0, updated = 0, kept = 0;
    for (const raw of data.notes) {
      if (!raw || typeof raw.id !== 'string') continue;
      const note = {
        id: raw.id,
        title: typeof raw.title === 'string' ? raw.title : '',
        text: typeof raw.text === 'string' ? raw.text : '',
        created: Number(raw.created) || now(),
        updated: Number(raw.updated) || now(),
        starred: Boolean(raw.starred),
      };
      if (typeof raw.folder === 'string') note.folder = raw.folder;
      if (typeof raw.html === 'string') note.html = sanitizeHtml(raw.html);
      if (Number.isFinite(raw.caret)) note.caret = raw.caret;
      const here = state.notes.find((n) => n.id === note.id);
      if (!here) { state.notes.push(note); added += 1; }
      else if (note.updated > here.updated) { Object.assign(here, note); updated += 1; }
      else kept += 1;
    }
    // Deleted notes travel too, so a restore on a fresh browser gives back Recently deleted
    // as well; a note that exists anywhere here already is left alone.
    // Folders by id, so a note's folder field still points at something after the merge.
    if (Array.isArray(data.folders)) {
      for (const raw of data.folders) {
        if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string' || folderOf(raw.id)) continue;
        state.folders.push({ id: raw.id, name: raw.name.trim().slice(0, 60) || 'Folder' });
      }
    }
    if (Array.isArray(data.trash)) {
      for (const raw of data.trash) {
        if (!raw || typeof raw.id !== 'string') continue;
        if (state.notes.some((n) => n.id === raw.id) || state.trash.some((n) => n.id === raw.id)) continue;
        const note = { id: raw.id, title: typeof raw.title === 'string' ? raw.title : '', text: typeof raw.text === 'string' ? raw.text : '',
          created: Number(raw.created) || now(), updated: Number(raw.updated) || now(), deletedAt: Number(raw.deletedAt) || now() };
        if (typeof raw.html === 'string') note.html = sanitizeHtml(raw.html);
        state.trash.push(note);
      }
    }
    // Punctuation words, keyed by language prefix as saveWords keeps them: the file fills in
    // languages this browser has not set up; words already chosen here stay.
    let words = 0;
    if (data.words && typeof data.words === 'object') {
      for (const [lang, table] of Object.entries(data.words)) {
        if (state.words[lang] || !table || typeof table !== 'object' || Array.isArray(table)) continue;
        const clean = {};
        for (const [slot, word] of Object.entries(table)) {
          if (typeof word === 'string' && word.trim()) clean[slot] = word.trim();
        }
        state.words[lang] = clean;
        words += 1;
      }
    }
    if (!current()) state.currentId = sorted(state.notes)[0] ? sorted(state.notes)[0].id : null;
    save(true);
    return { added, updated, kept, words };
  }

  function describeRestore(r) {
    const parts = [];
    if (r.added) parts.push(`${r.added} ${r.added === 1 ? 'note' : 'notes'} added`);
    if (r.updated) parts.push(`${r.updated} updated`);
    if (r.kept) parts.push(`${r.kept} already here`);
    if (r.words) parts.push(`punctuation words for ${r.words} ${r.words === 1 ? 'language' : 'languages'}`);
    return parts.length ? 'Restored: ' + parts.join(', ') + '.' : 'Nothing new in that backup.';
  }

  $('backupSave').addEventListener('click', () => {
    save(true);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadFile(`voice-typing-notes-${stamp}.json`, JSON.stringify(makeBackup(), null, 2), 'application/json');
    const n = state.notes.length;
    $('backupStatus').textContent = `Saved ${n} ${n === 1 ? 'note' : 'notes'} to voice-typing-notes-${stamp}.json.`;
  });

  $('backupLoad').addEventListener('click', () => $('backupFile').click());
  $('backupFile').addEventListener('change', async () => {
    const file = $('backupFile').files && $('backupFile').files[0];
    $('backupFile').value = '';
    if (!file) return;
    try {
      const result = restoreBackup(JSON.parse(await file.text()));
      render();
      $('backupStatus').textContent = describeRestore(result);
    } catch (e) {
      $('backupStatus').textContent = e instanceof SyntaxError
        ? 'That file could not be read as a backup.' : (e.message || 'Could not restore.');
    }
  });

  /* ---------- automatic backup to a folder ----------
   *
   * A page cannot write to disk on its own. What it can do, in Chrome and Edge, is ask once
   * for a folder (File System Access API) and keep the handle: from then on every change is
   * written there as voice-typing-notes.json, a couple of seconds after it happens. The
   * handle lives in IndexedDB so it survives a reload; after a browser restart Chrome may
   * ask for the folder permission again, and asking needs a click - so the page shows a
   * Resume button rather than prompting out of the blue.
   *
   * Only the content that a backup holds is compared before writing: a caret move saves
   * state, but it is not a reason to touch the file.
   */

  const AUTO_FILE = 'voice-typing-notes.json';
  const AUTO_DELAY_MS = 2000;
  const HANDLE_DB = 'voiceTypingNotepad';
  const HANDLE_KEY = 'autoBackupDir';

  const autoSupported = typeof window.showDirectoryPicker === 'function';
  let autoDir = null;          // the directory handle, or null when off
  let autoStatus = 'off';      // off | on | paused | unsupported
  let autoTimer = null;
  let autoLastPayload = '';
  let autoLastAt = 0;
  let autoError = '';

  function openHandleDb() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(HANDLE_DB, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function loadHandle() {
    const db = await openHandleDb();
    return new Promise((resolve) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  async function storeHandle(handle) {
    const db = await openHandleDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      if (handle) tx.objectStore('kv').put(handle, HANDLE_KEY); else tx.objectStore('kv').delete(HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function renderAutoBackup() {
    const status = $('autoStatus');
    const on = $('autoOn'), resume = $('autoResume'), off = $('autoOff');
    $('autoPaused').hidden = autoStatus !== 'paused';
    if (!autoSupported) {
      status.textContent = 'Not available in this browser — Chrome or Edge can do it.';
      on.disabled = true; resume.hidden = true; off.hidden = true;
      return;
    }
    on.disabled = false;
    const where = autoDir ? `"${autoDir.name}"` : 'a folder';
    if (autoStatus === 'on') {
      const when = autoLastAt ? ` Last written ${new Date(autoLastAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.` : '';
      status.textContent = `On — ${AUTO_FILE} in ${where}.${when}${autoError ? ' ' + autoError : ''}`;
      on.textContent = 'Change folder…'; resume.hidden = true; off.hidden = false;
    } else if (autoStatus === 'paused') {
      status.textContent = `Paused — the browser needs permission for ${where} again.`;
      on.textContent = 'Change folder…'; resume.hidden = false; off.hidden = false;
    } else {
      status.textContent = 'Off.';
      on.textContent = 'Choose a folder…'; resume.hidden = true; off.hidden = true;
    }
  }

  async function writeAutoBackup(force) {
    if (!autoDir) return false;
    const payload = JSON.stringify(makeBackup(), null, 2);
    // makeBackup stamps the time, so compare the notes themselves.
    const body = JSON.stringify({ n: state.notes, f: state.folders, t: state.trash, w: state.words });
    if (!force && body === autoLastPayload) return true;
    try {
      const perm = await autoDir.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') { autoStatus = 'paused'; renderAutoBackup(); return false; }
      const file = await autoDir.getFileHandle(AUTO_FILE, { create: true });
      const w = await file.createWritable();
      await w.write(payload);
      await w.close();
      autoLastPayload = body;
      autoLastAt = now();
      autoError = '';
      autoStatus = 'on';
    } catch (e) {
      // The folder was moved or deleted, or the disk refused. Said in the status line and
      // left on: the next change tries again.
      autoError = 'The last write failed: ' + (e && e.message ? e.message : e);
      autoStatus = 'on';
    }
    renderAutoBackup();
    return !autoError;
  }

  function scheduleAutoBackup() {
    if (!autoDir) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => writeAutoBackup(false), AUTO_DELAY_MS);
  }

  async function chooseAutoFolder() {
    if (!autoSupported) return;
    let dir;
    try {
      dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'voice-typing-backup', startIn: 'documents' });
    } catch {
      return; // the picker was closed
    }
    autoDir = dir;
    autoStatus = 'on';
    renderAutoBackup();
    await writeAutoBackup(true);
    flash(autoError ? 'Could not write the backup' : `Backup written to "${dir.name}"`);
    // Kept for the next visit - after the write, so a slow database never delays the file.
    storeHandle(dir).catch(() => { /* the handle cannot be kept: on for this visit only */ });
  }

  async function resumeAutoBackup() {
    if (!autoDir) return;
    try {
      const perm = await autoDir.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') return;
    } catch { return; }
    autoStatus = 'on';
    await writeAutoBackup(true);
  }

  async function stopAutoBackup() {
    autoDir = null;
    autoStatus = 'off';
    autoLastPayload = '';
    autoError = '';
    clearTimeout(autoTimer);
    renderAutoBackup();
    storeHandle(null).catch(() => { /* nothing kept, nothing to clear */ });
  }

  $('autoOn').addEventListener('click', chooseAutoFolder);
  $('autoResume').addEventListener('click', resumeAutoBackup);
  $('autoResumeTop').addEventListener('click', resumeAutoBackup);
  $('autoOff').addEventListener('click', stopAutoBackup);

  if (!autoSupported) autoStatus = 'unsupported';
  renderAutoBackup();
  if (autoSupported) {
    loadHandle().then(async (handle) => {
      if (!handle || typeof handle.queryPermission !== 'function') return;
      autoDir = handle;
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      autoStatus = perm === 'granted' ? 'on' : 'paused';
      renderAutoBackup();
      if (perm === 'granted') writeAutoBackup(false);
    }).catch(() => { /* no IndexedDB here: auto-backup stays off */ });
  }

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
    // The third panel, How it works, moved in from a card under the note the same day:
    // the page is for typing, and a block of explanation under the text was in the way.
    const titles = { sheetWords: 'Spoken punctuation', sheetSettings: 'Settings', sheetHelp: 'How it works' };
    for (const id of Object.keys(titles)) $(id).hidden = id !== which;
    $('sheetTitle').textContent = titles[which];
    if (which === 'sheetWords') {
      cmdLangSelect.value = state.lang;
      renderCommandRows();
    }
    sheet.classList.add('open'); sheetBack.classList.add('open');
    sheet.querySelector('.sbody').scrollTop = 0;
    closeSide();
  }
  function closeSheet() { sheet.classList.remove('open'); sheetBack.classList.remove('open'); stopHotkeyRecording(); }
  $('menuHelp').addEventListener('click', () => openSheet('sheetHelp'));
  $('menuTrash').addEventListener('click', showTrash);
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
    if (!current() || inTrash(current())) createNote();
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
      lastSpeechAt = Date.now();
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
    lastSpeechAt = Date.now();
    clearInterval(idleTimer);
    idleTimer = setInterval(watchIdle, 1000);
    try {
      r.start();
    } catch (error) {
      setLive(`Could not start: ${error.message}`, 'err');
      setListening(false);
      recognition = null;
    }
  }

  /*
   * Silence ends the session, as it does in the extension: 30 seconds without a result and
   * the microphone is released, with a countdown in the strip for the last five. Without
   * this the page listened forever - noticed 2026-09-12 as "it is on for good". The clock
   * is the time of the last RESULT, not of a restart: Chrome restarts a continuous session
   * every few seconds of quiet, and a countdown reset by that could never run out.
   */
  const IDLE_TIMEOUT_MS = 30_000;
  const IDLE_WARNING_SEC = 5;
  let lastSpeechAt = 0;
  let idleTimer = null;

  function watchIdle() {
    if (!listening) { clearInterval(idleTimer); idleTimer = null; return; }
    const secondsLeft = Math.ceil((IDLE_TIMEOUT_MS - (Date.now() - lastSpeechAt)) / 1000);
    if (secondsLeft <= 0) {
      stopRecognition(true);
      flash('Stopped — nothing heard for 30 seconds', 'hint');
      return;
    }
    if (secondsLeft <= IDLE_WARNING_SEC) {
      setLive(`Still there? Stopping in ${secondsLeft}…`, 'hint');
    } else if (live.classList.contains('hint') && /^Still there/.test(live.textContent)) {
      setLive('Start speaking');
    }
  }

  function stopRecognition(keepMessage) {
    const r = recognition;
    recognition = null;
    clearInterval(idleTimer);
    idleTimer = null;
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
  /*
   * The combination itself is the user's to choose (Settings > Keyboard), stored as a
   * string like "Ctrl+Shift+V". Only combinations with a modifier - or an F-key - are
   * accepted, so a plain letter can never be taken away from typing. Ctrl+Shift+D stays as
   * the fixed second key for the Linux case above.
   */

  const MODIFIER_KEYS = new Set(['control', 'shift', 'alt', 'meta']);

  /** @returns {string|null} the combination a key event spells, or null if it is not one. */
  function comboOf(event) {
    const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
    if (MODIFIER_KEYS.has(key.toLowerCase())) return null;
    const isFn = /^F([1-9]|1[0-2])$/.test(key);
    if (!isFn && !event.ctrlKey && !event.altKey && !event.metaKey) return null;
    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    parts.push(key === ' ' ? 'Space' : key);
    return parts.join('+');
  }

  const hotkeyBtn = $('hotkey');
  let recordingHotkey = false;

  function renderHotkey() {
    $('hotkeyLabel').textContent = recordingHotkey ? 'Press keys…' : state.hotkey;
    for (const el of document.querySelectorAll('.rec-btn .kbd')) {
      el.textContent = state.hotkey;
      el.title = state.hotkey + ', or Ctrl+Shift+D';
    }
    hotkeyBtn.classList.toggle('recording', recordingHotkey);
  }

  function stopHotkeyRecording() {
    if (!recordingHotkey) return;
    recordingHotkey = false;
    renderHotkey();
  }

  hotkeyBtn.addEventListener('click', () => {
    recordingHotkey = !recordingHotkey;
    renderHotkey();
  });
  hotkeyBtn.addEventListener('blur', stopHotkeyRecording);
  $('hotkeyReset').addEventListener('click', () => {
    state.hotkey = 'Ctrl+Q';
    save(true);
    stopHotkeyRecording();
    renderHotkey();
  });

  document.addEventListener('keydown', (event) => {
    if (recordingHotkey) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') { stopHotkeyRecording(); return; }
      const combo = comboOf(event);
      if (!combo) return;                     // a lone modifier, or a bare letter: keep waiting
      state.hotkey = combo;
      save(true);
      stopHotkeyRecording();
      flash('Shortcut set to ' + combo);
      return;
    }
    const combo = comboOf(event);
    const toggle = combo === state.hotkey || combo === 'Ctrl+Shift+D';
    if (toggle) {
      event.preventDefault();
      if (listening) stopRecognition(); else startRecognition();
      return;
    }
    if (combo === 'Ctrl+Alt+N') {
      event.preventDefault();
      createNote();
      return;
    }
    if (event.key === 'Escape' && listening) stopRecognition();
  });
  renderHotkey();

  // Leaving the page must not leave a microphone open.
  window.addEventListener('pagehide', () => {
    if (listening) stopRecognition();
    // Whatever the debounce was still holding - the last keystrokes, the caret - goes out now.
    save(true);
  });

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
  // The note that was open comes back open, with the caret where it was left. On a phone
  // the caret is not placed: focusing the editor would raise the keyboard over the page.
  purgeTrash();
  render(window.matchMedia('(hover: hover)').matches);
})();
