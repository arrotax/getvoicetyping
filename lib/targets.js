/**
 * Insertion targets.
 *
 * Until Google Docs, every place we typed into was a field we could read: the text on
 * either side of the caret was there for the asking, so spacing, sentence casing and
 * "scratch that" could all be decided from the page itself. Docs is the first target that
 * only accepts writes, and folding that into the old code path would have meant a
 * `if (docs)` at every one of those decisions.
 *
 * So the decisions move behind one small interface, and each target answers for itself:
 *
 *   kind            - 'dom' or 'docs', for messages the user sees
 *   canRead         - whether the surrounding text can be read at all
 *   supportsDelete  - whether "scratch that" can take a phrase back out
 *   isReady()       - the target is still there and still usable
 *   startsSentence()- should the next phrase be capitalized
 *   insert(text)    - put a finished phrase in; may be async
 *   deleteLast()    - undo our own last insert
 *   noteDisturbed(kind) - the caret may have moved; 'selection' if something was selected
 *
 * The DOM target is the old behaviour, moved rather than rewritten: it calls the same
 * lib/insert.js functions with the same arguments, so the existing tests still describe
 * it exactly. The Docs target is new and deliberately admits what it cannot do.
 */

globalThis.VoiceTypeTargets = (() => {
  const Insert = globalThis.VoiceTypeInsert;
  const Docs = globalThis.VoiceTypeDocs;

  /** How many of our own inserts stay eligible for "scratch that". */
  const UNDO_DEPTH = 10;

  /**
   * A real field: <input>, <textarea> or a contenteditable host.
   *
   * @param {{el: Element|null, start: number|null, end: number|null, range: Range|null}} saved
   *   the caret snapshot content.js keeps up to date as the user moves around. Held by
   *   reference on purpose - focus tracking writes to it during a session.
   */
  function createDomTarget(saved) {
    const inserts = [];

    function context() {
      const field = saved.el;
      if (!field || !field.isConnected) return null;

      if (Insert.isInputLike(field)) {
        const start = saved.start ?? field.value.length;
        const end = saved.end ?? start;
        const { before, after } = Insert.readContext(field, start, end);
        return { field, before, after, start, end, unknown: false };
      }

      // Rich editor: read the text around the caret so spacing and casing match what the
      // plain fields do. If the caret is not readable, fall back to appending at the end.
      const ctx = Insert.readEditableContext(field);
      if (ctx) return { field, before: ctx.before, after: ctx.after, start: null, end: null, unknown: false };
      return { field, before: field.textContent || '', after: '', start: null, end: null, unknown: false };
    }

    function remember(field, piece, start) {
      inserts.push({ field, piece, start });
      if (inserts.length > UNDO_DEPTH) inserts.shift();
    }

    return {
      kind: 'dom',
      canRead: true,
      supportsDelete: true,

      isReady() {
        const field = saved.el;
        return Boolean(field && field.isConnected);
      },

      context,

      startsSentence() {
        const ctx = context();
        if (!ctx) return true;
        return Insert.computeJoin(ctx.before, ctx.after, '').startsSentence;
      },

      /** @returns {{ok: boolean, piece?: string, reason?: string}} */
      insert(text) {
        const ctx = context();
        if (!ctx) return { ok: false, reason: 'no-field' };
        if (!text) return { ok: false, reason: 'empty' };

        const { piece } = Insert.computeJoin(ctx.before, ctx.after, text);

        if (Insert.isInputLike(ctx.field)) {
          const caret = Insert.insertIntoInput(ctx.field, piece, ctx.start, ctx.end);
          // Record what actually landed, and where, so "scratch that" can take back
          // exactly this and nothing more. A replaced selection makes the old text
          // unrecoverable, so that case is not offered for undo.
          if (ctx.start === ctx.end) remember(ctx.field, piece, ctx.start);
          else inserts.length = 0;
          saved.start = caret;
          saved.end = caret;
          return { ok: true, piece };
        }

        Insert.insertIntoEditable(ctx.field, piece, saved.range);
        // Offsets mean nothing in a rich editor, so the deletion path verifies by reading
        // the characters back instead; `start` is unused there.
        remember(ctx.field, piece, 0);
        // The editor has moved the caret past what we inserted; the stale clone would drag
        // the next phrase back to where this one started.
        saved.range = null;
        return { ok: true, piece };
      },

      /** @returns {'ok'|'nothing'|'changed'} */
      deleteLast() {
        const last = inserts[inserts.length - 1];
        if (!last) return 'nothing';

        const removed = Insert.deleteInserted(last.field, last.piece, last.start);
        inserts.pop();
        if (!removed) return 'changed';

        // The caret is back where this phrase began, which is where the previous one
        // ended - so a second "scratch that" works on the one before it.
        if (Insert.isInputLike(last.field)) {
          saved.el = last.field;
          saved.start = last.start;
          saved.end = last.start;
        }
        saved.range = null;
        return 'ok';
      },

      noteDisturbed() {
        // Nothing to forget: this target reads the live document every time.
      },
    };
  }

  /**
   * Google Docs, reached through a synthetic paste into its hidden input sink.
   *
   * Everything this target cannot do follows from one fact: the document is drawn on a
   * canvas and cannot be read back. So joining runs off a remembered tail rather than the
   * real text, "scratch that" is refused outright, and success is not verifiable - see
   * lib/docs.js for the measurements behind each of those.
   *
   * @param {{send: (text: string) => Promise<{sent: boolean, cancelled: boolean, reason?: string}>}} bridge
   *   carries one phrase to the frame that owns the sink, since it is not this one.
   */
  function createDocsTarget(bridge) {
    const join = Docs.createJoin();
    let broken = false;

    return {
      kind: 'docs',
      canRead: false,
      supportsDelete: false,

      isReady() {
        return !broken;
      },

      context() {
        return join.context();
      },

      startsSentence() {
        // No special case any more: createJoin picks a `before` that already encodes what
        // it knows, and computeJoin reads capitalization out of it the same way it does
        // for a real field.
        const ctx = join.context();
        return Insert.computeJoin(ctx.before, ctx.after, '').startsSentence;
      },

      /** @returns {Promise<{ok: boolean, piece?: string, reason?: string}>} */
      async insert(text) {
        if (!text) return { ok: false, reason: 'empty' };

        const ctx = join.context();
        const { piece } = Insert.computeJoin(ctx.before, ctx.after, text);

        // What goes over the wire is doubled where a separator is needed - see forPaste.
        // The tail below records the logical piece, because one space is what the document
        // actually ends up holding.
        const outcome = await bridge.send(Docs.forPaste(piece));
        if (!outcome || !outcome.sent) {
          // The sink is gone or unreachable. Nothing was inserted - Chrome runs no default
          // action for an untrusted paste - so the caller can show the text unharmed.
          join.reset('caret');
          broken = true;
          return { ok: false, piece, reason: (outcome && outcome.reason) || 'not-sent' };
        }

        join.noteSent(piece);
        return { ok: true, piece };
      },

      deleteLast() {
        return 'unsupported';
      },

      /**
       * @param {'caret'|'selection'} kind see createJoin's reset - a drag or double click
       *   means the next phrase replaces a selection, which needs different joining from
       *   a plain click.
       */
      noteDisturbed(kind) {
        join.reset(kind);
      },
    };
  }

  return { createDomTarget, createDocsTarget, UNDO_DEPTH };
})();
