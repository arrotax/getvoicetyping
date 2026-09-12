/**
 * The start/stop sound, shared by the offscreen document and the settings page.
 *
 * Deliberately NOT Web Audio. The cue is played from the same offscreen document that
 * runs speech recognition, and opening an AudioContext there appeared to disturb the
 * microphone pipeline - recognition would report `network` and pick nothing up. An
 * <audio> element playing a pre-rendered clip touches no audio graph and cannot interfere
 * with capture.
 *
 * The clip is synthesized once into a data URI, so there is still no asset to ship and
 * the volume and envelope stay under our control.
 */

globalThis.VoiceTypeCue = (() => {
  /*
   * Reworked on 2026-09-10: the old cue was two bare sine tones, D5 then A5, 120ms each,
   * butted end to end. Reported as too sharp, and the reasons are all in that sentence.
   *
   *   - 880 Hz is where a pure sine is at its most piercing.
   *   - A bare sine has no body, so it reads as a device beep rather than a note.
   *   - The notes did not overlap and held a flat level to the end, which is a buzzer,
   *     not a melody.
   *
   * What replaces it: a lower pair, a plucked decay instead of a flat hold, two quiet
   * harmonics for warmth, and an overlap so the two notes belong to one gesture.
   */
  const SAMPLE_RATE = 22050;

  /** A4 and E5 - a fifth, low enough to stay warm and still cut through a room. */
  const LOW = 440;
  const HIGH = 659.25;

  const NOTE_SECONDS = 0.26;
  /** The second note begins while the first is still ringing, so it is one phrase. */
  const OVERLAP_SECONDS = 0.1;
  const PEAK = 0.2;

  /**
   * Harmonics above the fundamental, quiet. A touch of the octave and the twelfth turns a
   * sine into something with a body to it, like a soft mallet. More than this and it
   * starts to buzz, which is the thing being fixed.
   */
  const HARMONICS = [
    { multiple: 1, level: 1 },
    { multiple: 2, level: 0.18 },
    { multiple: 3, level: 0.06 },
  ];

  const cache = {};

  function writeAscii(view, offset, text) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }

  /** Builds a mono 16-bit PCM WAV of the given tones, overlapping into one phrase. */
  function renderWav(frequencies) {
    const noteFrames = Math.floor(SAMPLE_RATE * NOTE_SECONDS);
    const stepFrames = Math.floor(SAMPLE_RATE * (NOTE_SECONDS - OVERLAP_SECONDS));
    const frames = stepFrames * (frequencies.length - 1) + noteFrames;
    const buffer = new ArrayBuffer(44 + frames * 2);
    const view = new DataView(buffer);

    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + frames * 2, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);                    // PCM
    view.setUint16(22, 1, true);                    // mono
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * 2, true);      // byte rate
    view.setUint16(32, 2, true);                    // block align
    view.setUint16(34, 16, true);                   // bits per sample
    writeAscii(view, 36, 'data');
    view.setUint32(40, frames * 2, true);

    // Mixed in floating point first: overlapping notes have to be summed, and summing
    // straight into 16-bit would clip on the way.
    const mix = new Float32Array(frames);
    const attackFrames = SAMPLE_RATE * 0.02;
    // How fast a note dies away. Around 7 gives a soft mallet: the note is clearly there
    // and clearly ending, without the flat hold that made the old cue a buzzer.
    const DECAY = 7;

    frequencies.forEach((frequency, index) => {
      const start = index * stepFrames;
      for (let n = 0; n < noteFrames; n++) {
        const t = n / SAMPLE_RATE;
        // Raised cosine in, exponential out. The curved attack is what removes the click
        // a linear ramp leaves at this length.
        const attack = n < attackFrames ? (1 - Math.cos((Math.PI * n) / attackFrames)) / 2 : 1;
        const envelope = attack * Math.exp(-DECAY * t);

        let sample = 0;
        for (const { multiple, level } of HARMONICS) {
          sample += Math.sin(2 * Math.PI * frequency * multiple * t) * level;
        }
        // Divided by the harmonic weight so adding a harmonic changes the colour, not the
        // loudness.
        mix[start + n] += (sample / 1.24) * envelope * PEAK;
      }
    });

    for (let n = 0; n < frames; n++) {
      const clamped = Math.max(-1, Math.min(1, mix[n]));
      view.setInt16(44 + n * 2, Math.round(clamped * 32767), true);
    }
    return new Uint8Array(buffer);
  }

  function dataUri(kind) {
    if (cache[kind]) return cache[kind];
    // Up to begin, down to end - the same shape as a door opening and closing.
    const tones = kind === 'start' ? [LOW, HIGH] : [HIGH, LOW];
    const bytes = renderWav(tones);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    cache[kind] = `data:audio/wav;base64,${btoa(binary)}`;
    return cache[kind];
  }

  function element(kind) {
    const audio = new Audio(dataUri(kind));
    audio.volume = 0.55;
    return audio;
  }

  /** Fire and forget - used where nobody is waiting on the result. */
  function play(kind) {
    try {
      const promise = element(kind).play();
      if (promise && promise.catch) promise.catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Waits for playback to actually begin and reports whether it did. Used by the settings
   * page's test button, where the user expects a definite answer.
   */
  async function playNow(kind) {
    try {
      await element(kind).play();
      return true;
    } catch {
      return false;
    }
  }

  return { play, playNow };
})();
