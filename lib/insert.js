/**
 * Text insertion. Split out of content.js so the joining rules can be exercised by a
 * real browser without a microphone (see tests/insert.test.html).
 *
 * Two layers:
 *   computeJoin() - pure. Decides spacing and sentence casing around the caret.
 *   insertInto*() - touches the DOM and fires the events editors listen for.
 */

globalThis.VoiceTypeInsert = (() => {
  const SENTENCE_END = /[.!?]["')\]]?\s*$/;
  const OPENS_WITH_PUNCT = /^[,.!?;:]/;

  /**
   * Works out exactly what to splice in between `before` and `after`.
   *
   * @param {string} before text to the left of the caret
   * @param {string} after text to the right of the caret (a selection is already removed)
   * @param {string} text the finished phrase to insert
   * @returns {{piece: string, startsSentence: boolean}}
   */
  function computeJoin(before, after, text) {
    const startsSentence = before.length === 0 || SENTENCE_END.test(before) || /\n[ \t]*$/.test(before);

    if (!text) return { piece: '', startsSentence };

    // No space in front of punctuation, of a line break, or at the very start of a field,
    // and never a second space when one is already there.
    const needsLead =
      before.length > 0 &&
      !/\s$/.test(before) &&
      !OPENS_WITH_PUNCT.test(text) &&
      !text.startsWith('\n');

    // A space after only when real text follows and the phrase did not end a line.
    const needsTrail =
      after.length > 0 &&
      !/^\s/.test(after) &&
      !text.endsWith('\n');

    return { piece: (needsLead ? ' ' : '') + text + (needsTrail ? ' ' : ''), startsSentence };
  }

  /** Reads the text on either side of the caret without modifying anything. */
  function readContext(field, start, end) {
    const value = field.value;
    return { before: value.slice(0, start), after: value.slice(end) };
  }

  /**
   * Node.contains() stops at a shadow boundary, so a caret inside a shadow root reads as
   * "not in this field" and the whole insert goes to the wrong place. Walk hosts too.
   */
  function containsDeep(root, node) {
    let current = node;
    while (current) {
      if (current === root) return true;
      current = current.parentNode || current.host || null;
    }
    return false;
  }

  /**
   * The contenteditable equivalent of readContext: the plain text before and after the
   * caret, so the same spacing and sentence-casing rules apply in rich editors.
   * @returns {{before: string, after: string, range: Range}|null}
   */
  function readEditableContext(field) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    if (!containsDeep(field, range.startContainer)) return null;

    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(field);
    beforeRange.setEnd(range.startContainer, range.startOffset);

    const afterRange = document.createRange();
    afterRange.selectNodeContents(field);
    afterRange.setStart(range.endContainer, range.endOffset);

    return { before: beforeRange.toString(), after: afterRange.toString(), range };
  }

  /** Puts a saved caret back when focus moved away and the selection was lost. */
  function restoreRange(field, range) {
    const selection = window.getSelection();
    if (!selection) return false;
    if (selection.rangeCount > 0 && containsDeep(field, selection.getRangeAt(0).startContainer)) {
      return true; // caret is already where it belongs
    }
    if (!range) return false;
    try {
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Inserts into <input> / <textarea>.
   *
   * execCommand is tried first even here: unlike a direct value write it keeps the
   * native undo stack intact, so Ctrl+Z still works after dictating. The native setter
   * is the fallback, and it is written through the prototype descriptor because React
   * replaces the instance setter to track changes and silently reverts plain writes.
   *
   * @returns {number} the caret position after the insert
   */
  function insertIntoInput(field, piece, start, end) {
    // A single-line <input> cannot hold a line break. Chrome's handling of one is
    // inconsistent - sometimes dropped, sometimes left as stray whitespace - so collapse
    // it to a single space ourselves and keep the result predictable.
    if (field instanceof HTMLInputElement) piece = piece.replace(/[ \t]*\n+[ \t]*/g, ' ');

    field.focus({ preventScroll: true });
    field.setSelectionRange(start, end);

    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, piece);
    } catch {
      inserted = false;
    }

    if (!inserted) {
      const value = field.value;
      const next = value.slice(0, start) + piece + value.slice(end);
      const proto =
        field instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      nativeSetter.call(field, next);
      const caret = start + piece.length;
      field.setSelectionRange(caret, caret);
      field.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: piece }),
      );
    }

    return field.selectionStart;
  }

  /**
   * Inserts into a contenteditable host. Rich editors (ProseMirror, Lexical, Slate) keep
   * their own state tree separate from the DOM and only notice edits that arrive as
   * genuine input events - which is exactly what execCommand still produces. Writing to
   * the DOM directly is invisible to them, so the manual path below is a last resort for
   * plain contenteditable only.
   *
   * Line breaks get their own command: a literal "\n" passed to insertText is collapsed
   * to a space by most editors rather than breaking the line.
   */
  function insertIntoEditable(field, piece, savedRange) {
    field.focus({ preventScroll: true });
    restoreRange(field, savedRange);

    const segments = piece.split('\n');
    let anyFailed = false;

    segments.forEach((segment, index) => {
      if (index > 0 && !execLineBreak()) anyFailed = true;
      if (segment && !execText(segment)) anyFailed = true;
    });

    if (!anyFailed) return true;
    return manualInsert(field, piece);
  }

  function execText(text) {
    try {
      return document.execCommand('insertText', false, text);
    } catch {
      return false;
    }
  }

  function execLineBreak() {
    try {
      // Chrome implements insertLineBreak; where it is missing, a newline via insertText
      // is still better than dropping the break entirely.
      if (document.execCommand('insertLineBreak')) return true;
      return document.execCommand('insertText', false, '\n');
    } catch {
      return false;
    }
  }

  /** Plain-DOM fallback. Works in a bare contenteditable, not in a framework editor. */
  function manualInsert(field, piece) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(piece);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    field.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: piece }),
    );
    return true;
  }

  function isInputLike(el) {
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  }

  /**
   * Removes a piece of text we inserted earlier, and only that.
   *
   * Every path verifies the characters about to go are byte-for-byte what we put there.
   * If the user has edited in the meantime the check fails and nothing is touched -
   * deleting the wrong text is far worse than refusing to delete at all.
   *
   * Deletion goes through execCommand so it lands on the same undo stack as the insert:
   * Ctrl+Z brings the phrase back.
   *
   * @returns {boolean} true if exactly that text was removed
   */
  function deleteInserted(field, piece, start) {
    if (!piece || !field || !field.isConnected) return false;

    if (isInputLike(field)) {
      const end = start + piece.length;
      if (field.value.slice(start, end) !== piece) return false;
      field.focus({ preventScroll: true });
      field.setSelectionRange(start, end);
      if (!tryExec('delete')) {
        // Fall back to the native setter for editors that refuse execCommand.
        const next = field.value.slice(0, start) + field.value.slice(end);
        const proto =
          field instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, next);
        field.dispatchEvent(
          new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }),
        );
      }
      field.setSelectionRange(start, start);
      return true;
    }

    // Rich editor: walk the selection back one character at a time, then check what got
    // selected really is our text before removing it. Character steps rather than word
    // steps because a phrase rarely lines up with the editor's idea of word boundaries.
    field.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    const anchor = selection.getRangeAt(0).cloneRange();
    selection.collapseToEnd();

    for (let i = 0; i < piece.length; i++) {
      selection.modify('extend', 'backward', 'character');
    }
    if (selection.toString() !== piece) {
      // Put the caret back exactly where it was and leave the text alone.
      selection.removeAllRanges();
      selection.addRange(anchor);
      return false;
    }
    const removed = tryExec('delete');
    if (!removed) {
      selection.removeAllRanges();
      selection.addRange(anchor);
      return false;
    }
    return true;
  }

  function tryExec(command) {
    try {
      return document.execCommand(command);
    } catch {
      return false;
    }
  }

  return {
    computeJoin,
    readContext,
    readEditableContext,
    restoreRange,
    containsDeep,
    insertIntoInput,
    insertIntoEditable,
    deleteInserted,
    isInputLike,
  };
})();
