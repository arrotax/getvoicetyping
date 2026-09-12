/**
 * Spoken punctuation commands. Pure functions only - no DOM, no chrome APIs - so the
 * whole module is testable in isolation (see tests/commands.test.html).
 *
 * Applied to FINAL transcripts only. Interim text is left raw so the live preview does
 * not jump around while Chrome is still revising its guess.
 *
 * Injected into the content script world alongside content.js, which is where the
 * surrounding field text is known - sentence casing depends on what sits before the caret.
 */

globalThis.VoiceTypeCommands = (() => {
  /**
   * Ordered longest-phrase-first so "new paragraph" wins over "new line", and
   * "full stop" is never mistaken for a stray "stop".
   */
  /**
   * Command tables per language. A new paragraph starts a new thought, so the next word
   * is capitalized; a plain line break does not, because a shopping list or an address
   * should not gain capitals just because the line wrapped. That split matches how
   * established dictation tools behave.
   *
   * Keep the set of languages here in step with COMMAND_LANG_PREFIXES in config.js -
   * that constant is what the settings page uses to tell the user which languages have
   * punctuation commands.
   */
  const SETS = {
    en: [
      { words: ['new', 'paragraph'], insert: '\n\n', kind: 'break', endsSentence: true },
      { words: ['question', 'mark'], insert: '?', kind: 'punct', endsSentence: true },
      { words: ['exclamation', 'mark'], insert: '!', kind: 'punct', endsSentence: true },
      { words: ['exclamation', 'point'], insert: '!', kind: 'punct', endsSentence: true },
      { words: ['full', 'stop'], insert: '.', kind: 'punct', endsSentence: true },
      { words: ['new', 'line'], insert: '\n', kind: 'break' },
      { words: ['semicolon'], insert: ';', kind: 'punct' },
      { words: ['colon'], insert: ':', kind: 'punct' },
      { words: ['period'], insert: '.', kind: 'punct', endsSentence: true },
      { words: ['comma'], insert: ',', kind: 'punct' },
      // An em dash takes a space on both sides, unlike the marks that hug the word
      // in front of them.
      { words: ['dash'], insert: '—', kind: 'spaced' },
    ],
    ru: [
      { words: ['восклицательный', 'знак'], insert: '!', kind: 'punct', endsSentence: true },
      { words: ['вопросительный', 'знак'], insert: '?', kind: 'punct', endsSentence: true },
      { words: ['точка', 'с', 'запятой'], insert: ';', kind: 'punct' },
      { words: ['знак', 'вопроса'], insert: '?', kind: 'punct', endsSentence: true },
      { words: ['новый', 'абзац'], insert: '\n\n', kind: 'break', endsSentence: true },
      { words: ['с', 'новой', 'строки'], insert: '\n', kind: 'break' },
      { words: ['новая', 'строка'], insert: '\n', kind: 'break' },
      { words: ['двоеточие'], insert: ':', kind: 'punct' },
      { words: ['запятая'], insert: ',', kind: 'punct' },
      { words: ['точка'], insert: '.', kind: 'punct', endsSentence: true },
      { words: ['тире'], insert: '—', kind: 'spaced' },
      { words: ['абзац'], insert: '\n\n', kind: 'break', endsSentence: true },
    ],
  };

  // Longest phrases first, so "точка с запятой" wins over "точка" and "new paragraph"
  // over "new line".
  for (const set of Object.values(SETS)) {
    set.sort((a, b) => b.words.length - a.words.length);
  }

  /** @returns {Array|null} the command table for a BCP 47 tag, or null if there is none */
  function commandsFor(lang) {
    const prefix = String(lang || '').slice(0, 2).toLowerCase();
    return SETS[prefix] || null;
  }

  /* ---------- commands the user writes themselves ----------
   *
   * The tables above are hand-written and exist for two languages. The extension offers
   * fifty-three, so fifty-one of them dictate without punctuation - and that gap cannot be
   * closed by us: nobody here knows how a Thai or Marathi speaker says "full stop", and
   * guessing would put wrong words in front of people who would then be told they are
   * commands.
   *
   * Somebody who speaks the language does know. So the words become a setting, one phrase
   * per slot, and the slots stay fixed.
   *
   * Fixed slots rather than free "say this, get that" mappings, deliberately: a full stop
   * carries the rule that the next word is capitalized, and a paragraph carries it too.
   * Let people map arbitrary text and that logic silently stops matching, so the visible
   * result is missing capitals with no explanation. What varies between languages is the
   * word, not what a full stop does.
   */

  /**
   * Every action a spoken word can be bound to. `id` is what storage holds, `label` is
   * what the settings page shows, and the rest is the behaviour, which is not editable.
   */
  const SLOTS = [
    { id: 'comma', label: 'Comma', shows: ',', insert: ',', kind: 'punct' },
    { id: 'period', label: 'Full stop', shows: '.', insert: '.', kind: 'punct', endsSentence: true },
    { id: 'question', label: 'Question mark', shows: '?', insert: '?', kind: 'punct', endsSentence: true },
    { id: 'exclamation', label: 'Exclamation mark', shows: '!', insert: '!', kind: 'punct', endsSentence: true },
    { id: 'colon', label: 'Colon', shows: ':', insert: ':', kind: 'punct' },
    { id: 'semicolon', label: 'Semicolon', shows: ';', insert: ';', kind: 'punct' },
    { id: 'dash', label: 'Dash', shows: '—', insert: '—', kind: 'spaced' },
    { id: 'newline', label: 'New line', shows: '↵', insert: '\n', kind: 'break' },
    { id: 'paragraph', label: 'New paragraph', shows: '¶', insert: '\n\n', kind: 'break', endsSentence: true },
    // Not punctuation: it takes back text that is already in the field. Carried in the
    // same list because to the person filling the form it is one more spoken word.
    { id: 'scratch', label: 'Take back the last phrase', shows: '⌫', action: 'delete-last' },
  ];

  /** The words the built-in tables use, so a language we do ship can be shown and edited. */
  function defaultWords(lang) {
    const table = commandsFor(lang);
    const words = {};
    if (table) {
      for (const slot of SLOTS) {
        if (slot.action) continue;
        const hit = table.find((c) => c.insert === slot.insert);
        if (hit) words[slot.id] = hit.words.join(' ');
      }
    }
    const prefix = String(lang || '').slice(0, 2).toLowerCase();
    const actions = ACTIONS[prefix];
    if (actions && actions.length) words.scratch = actions[0].words.join(' ');
    return words;
  }

  /**
   * Turns {slotId: 'phrase'} into the same shape the built-in tables have.
   *
   * Empty and missing phrases are dropped rather than stored as blanks: an empty slot is
   * a language that has no word for that mark yet, not a command matching nothing.
   *
   * @returns {{punctuation: Array, actions: Array}}
   */
  function buildTable(words) {
    const punctuation = [];
    const actions = [];
    for (const slot of SLOTS) {
      const phrase = String((words && words[slot.id]) || '').trim();
      if (!phrase) continue;
      const parts = phrase.split(/\s+/).map(normalize).filter(Boolean);
      if (parts.length === 0) continue;
      if (slot.action) actions.push({ words: parts, action: slot.action });
      else {
        punctuation.push({
          words: parts, insert: slot.insert, kind: slot.kind, endsSentence: slot.endsSentence,
        });
      }
    }
    // Longest first, exactly as the built-in tables are sorted: a two-word phrase must
    // never lose to a one-word phrase that is its prefix.
    punctuation.sort((a, b) => b.words.length - a.words.length);
    actions.sort((a, b) => b.words.length - a.words.length);
    return { punctuation, actions };
  }

  /**
   * Actions are not punctuation - they change text that is already in the field, so a
   * false match destroys the user's work rather than adding a stray comma. Two defences:
   * every phrase is several words long and unlikely to be dictated by accident, and a
   * transcript only counts as an action when it consists of nothing else (see matchAction).
   */
  const ACTIONS = {
    en: [
      { words: ['scratch', 'that'], action: 'delete-last' },
      { words: ['strike', 'that'], action: 'delete-last' },
    ],
    ru: [
      { words: ['зачеркни', 'последнее'], action: 'delete-last' },
      { words: ['зачеркнуть', 'последнее'], action: 'delete-last' },
    ],
  };

  /** Speech results carry no punctuation, but strip anyway so matching stays robust. */
  function normalize(word) {
    return word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  }

  /**
   * Recognizes an action that ENDS the utterance, and reports what was said before it.
   *
   * It cannot require the command to stand alone: Chrome often does not finalize a phrase
   * before the next words arrive, so "hello world scratch that" turns up as one result and
   * an exact-match rule typed the command out instead of obeying it.
   *
   * Trailing-only keeps the guarantee that matters. "please scratch that itch" is still
   * plain text, because the command is not at the end.
   *
   * @returns {{action: string, rest: string}|null} `rest` is the speech preceding the
   *   command - words the user retracted in the same breath, so they were never committed.
   */
  function matchAction(transcript, lang, words) {
    // A user-written table wins outright when there is one: it IS the language's set of
    // commands, not an addition to ours.
    const table = words ? buildTable(words).actions
      : ACTIONS[String(lang || 'en').slice(0, 2).toLowerCase()];
    if (!table || table.length === 0) return null;

    const spoken = String(transcript).trim().split(/\s+/).filter(Boolean);
    if (spoken.length === 0) return null;
    const normalized = spoken.map(normalize);

    // Longest phrase first, so a two-word command never loses to a one-word prefix.
    const ordered = table.slice().sort((a, b) => b.words.length - a.words.length);

    for (const entry of ordered) {
      const at = normalized.length - entry.words.length;
      if (at < 0) continue;
      if (!entry.words.every((w, i) => w === normalized[at + i])) continue;
      return { action: entry.action, rest: spoken.slice(0, at).join(' ') };
    }
    return null;
  }

  function matchAt(table, words, index) {
    for (const command of table) {
      const phrase = command.words;
      if (index + phrase.length > words.length) continue;
      let hit = true;
      for (let i = 0; i < phrase.length; i++) {
        if (normalize(words[index + i]) !== phrase[i]) { hit = false; break; }
      }
      if (hit) return command;
    }
    return null;
  }

  function capitalizeWord(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  /*
   * The recognizer's own capital is left alone, and that is a reversal.
   *
   * Stripping it was added on 2026-09-08 to stop a capital appearing mid-sentence when
   * someone paused and carried on. It did stop that, and caused something worse: people
   * dictate in separate phrases far more often than they pause mid-sentence, so nearly
   * every phrase came back lowercased - sentences that should have started with a capital,
   * and names along with them. Listing exceptions did not scale past "I".
   *
   * The two cannot both be satisfied without understanding the sentence. Between a stray
   * capital mid-sentence and a missing one at the start, the missing capital is both more
   * common and more obviously wrong, so Chrome's guess stands.
   */

  /**
   * Turns a raw final transcript into finished text.
   *
   * @param {string} transcript raw text from SpeechRecognition
   * @param {{lang?: string, punctuation?: boolean, capitalize?: boolean, startsSentence?: boolean}} [options]
   *   lang           - BCP 47 tag; picks the command table. Defaults to English
   *   punctuation    - false leaves spoken command words as literal text
   *   capitalize     - false skips automatic sentence casing
   *   startsSentence - true when the caret sits at the start of a sentence
   * @returns {string}
   */
  function applyCommands(transcript, options) {
    const opts = options || {};
    const doCaps = opts.capitalize !== false;
    const startsSentence = opts.startsSentence !== false;

    // No table for this language means the text passes through untouched - better than
    // matching English words against, say, Korean and inventing punctuation.
    // Same rule as matchAction: words the user wrote replace the built-in table rather
    // than adding to it.
    const table = opts.punctuation === false
      ? null
      : (opts.words ? buildTable(opts.words).punctuation : commandsFor(opts.lang || 'en'));

    const words = String(transcript).trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '';

    const tokens = [];
    for (let i = 0; i < words.length; i++) {
      const command = table ? matchAt(table, words, i) : null;
      if (command) {
        tokens.push({ type: command.kind, value: command.insert, endsSentence: command.endsSentence });
        i += command.words.length - 1;
      } else {
        tokens.push({ type: 'word', value: words[i] });
      }
    }

    let out = '';
    let atSentenceStart = doCaps && startsSentence;

    for (const token of tokens) {
      if (token.type === 'word') {
        // Space before every word except at the very start or right after a line break.
        if (out && !out.endsWith('\n')) out += ' ';
        if (atSentenceStart) out += capitalizeWord(token.value);
        else out += token.value;
        atSentenceStart = false;
      } else if (token.type === 'punct') {
        // Punctuation hugs the preceding word: never a space in front of it.
        out += token.value;
        if (doCaps && token.endsSentence) atSentenceStart = true;
      } else if (token.type === 'spaced') {
        // Takes a space in front; the following word supplies the one behind it.
        if (out && !out.endsWith('\n')) out += ' ';
        out += token.value;
      } else {
        out = out.replace(/[ \t]+$/, '') + token.value;
        // Only a paragraph break starts a sentence. A line break leaves the state alone,
        // so "done period new line next" still capitalizes Next - the period decided that,
        // not the break.
        if (doCaps && token.endsSentence) atSentenceStart = true;
      }
    }

    return out;
  }

  /** Which phrases a given language understands - handy for tests and for the UI. */
  function commandList(lang) {
    const table = commandsFor(lang || 'en');
    if (!table) return [];
    return table.map((c) => ({
      phrase: c.words.join(' '),
      inserts: c.insert.replace(/\n/g, '\\n'),
    }));
  }

  /** The action phrases a language understands - for the settings page and for tests. */
  function actionList(lang) {
    const prefix = String(lang || 'en').slice(0, 2).toLowerCase();
    return (ACTIONS[prefix] || []).map((a) => ({ phrase: a.words.join(' '), action: a.action }));
  }

  return {
    applyCommands, commandsFor, commandList, matchAction, actionList,
    SLOTS, defaultWords, buildTable,
  };
})();
