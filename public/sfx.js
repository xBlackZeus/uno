/* Sound effects, synthesised in the browser.
 *
 * No audio files. Every sound is a few oscillators and an envelope built on
 * demand, which means no network request, no decode delay on a phone, nothing
 * to cache, and a few hundred bytes instead of a few hundred kilobytes.
 *
 * Autoplay policy: an AudioContext cannot start until the player has interacted
 * with the page. We create it lazily on the first real gesture and stay silent
 * until then, so nothing ever tries to play before it is allowed to.
 */

(() => {
  'use strict';

  const STORE_KEY = 'uno:audio';

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        return {
          sfx: p.sfx !== false,
          volume: typeof p.volume === 'number' ? Math.min(1, Math.max(0, p.volume)) : 0.7,
        };
      }
    } catch {
      /* private mode */
    }
    return { sfx: true, volume: 0.7 };
  }

  class Sfx {
    constructor() {
      this.prefs = loadPrefs();
      this.ctx = null;
      this.master = null;
      this.unlocked = false;
    }

    save() {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(this.prefs));
      } catch {
        /* private mode */
      }
    }

    /** Called from the first user gesture. Safe to call repeatedly. */
    unlock() {
      if (this.unlocked) return;
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.prefs.volume;
        this.master.connect(this.ctx.destination);
        this.unlocked = true;
      } catch {
        this.ctx = null;
      }
      // iOS keeps the context suspended until a gesture is *inside* the page.
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    }

    get enabled() {
      return this.prefs.sfx;
    }

    setEnabled(on) {
      this.prefs.sfx = Boolean(on);
      this.save();
    }

    setVolume(v) {
      this.prefs.volume = Math.min(1, Math.max(0, Number(v) || 0));
      if (this.master) this.master.gain.value = this.prefs.volume;
      this.save();
    }

    get volume() {
      return this.prefs.volume;
    }

    /**
     * One shaped tone. `slide` sweeps the pitch, which is what turns a beep into
     * a sweep that reads as movement rather than as a notification.
     */
    tone({ freq = 440, to = null, dur = 0.12, type = 'sine', gain = 0.3, delay = 0, curve = 'exp' }) {
      if (!this.prefs.sfx || !this.unlocked || !this.ctx) return;
      const ctx = this.ctx;
      const t0 = ctx.currentTime + delay;

      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (to !== null) {
        if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
        else osc.frequency.linearRampToValueAtTime(to, t0 + dur);
      }

      // A fast attack and a long-ish decay: percussive, never clicky.
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + 0.008);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      osc.connect(env);
      env.connect(this.master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }

    /** Filtered noise burst — the basis of anything that sounds like paper. */
    noise({ dur = 0.14, gain = 0.16, delay = 0, from = 900, to = 2600, q = 1.1 }) {
      if (!this.prefs.sfx || !this.unlocked || !this.ctx) return;
      const ctx = this.ctx;
      const t0 = ctx.currentTime + delay;
      const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = q;
      filter.frequency.setValueAtTime(from, t0);
      filter.frequency.exponentialRampToValueAtTime(to, t0 + dur);

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      src.connect(filter);
      filter.connect(env);
      env.connect(this.master);
      src.start(t0);
      src.stop(t0 + dur + 0.02);
    }

    // ── The actual cues ─────────────────────────────────────────────────────

    /** Card hitting the table: a slap plus a low thock. */
    play() {
      this.noise({ dur: 0.1, gain: 0.2, from: 1400, to: 3200 });
      this.tone({ freq: 190, to: 96, dur: 0.13, type: 'triangle', gain: 0.22 });
    }

    /** Sliding a card off the deck. */
    draw() {
      this.noise({ dur: 0.16, gain: 0.13, from: 700, to: 2100, q: 0.8 });
    }

    /** Unplayable nudge. Deliberately soft: it fires often. */
    reject() {
      this.tone({ freq: 220, to: 165, dur: 0.11, type: 'sine', gain: 0.12 });
    }

    /** Anything tappable. Very quiet — this can fire on every press. */
    tap() {
      this.tone({ freq: 620, to: 880, dur: 0.045, type: 'sine', gain: 0.09 });
    }

    turn() {
      this.tone({ freq: 520, dur: 0.08, type: 'sine', gain: 0.1 });
      this.tone({ freq: 780, dur: 0.1, type: 'sine', gain: 0.09, delay: 0.07 });
    }

    /** UNO: a bright rising triad, the one sound allowed to be loud. */
    uno() {
      [523.25, 659.25, 783.99].forEach((f, i) => {
        this.tone({ freq: f, dur: 0.22, type: 'triangle', gain: 0.2, delay: i * 0.055 });
      });
      this.noise({ dur: 0.3, gain: 0.07, from: 2000, to: 6000, delay: 0.02 });
    }

    /** Caught out. A short descending pair. */
    caught() {
      this.tone({ freq: 440, to: 330, dur: 0.1, type: 'square', gain: 0.1 });
      this.tone({ freq: 330, to: 247, dur: 0.16, type: 'square', gain: 0.1, delay: 0.09 });
    }

    join() {
      this.tone({ freq: 480, to: 720, dur: 0.1, type: 'sine', gain: 0.1 });
    }

    leave() {
      this.tone({ freq: 480, to: 300, dur: 0.12, type: 'sine', gain: 0.09 });
    }

    /** Victory: a short major run. */
    win() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        this.tone({ freq: f, dur: 0.34, type: 'triangle', gain: 0.19, delay: i * 0.1 });
      });
      this.noise({ dur: 0.5, gain: 0.05, from: 1800, to: 7000, delay: 0.1 });
    }

    /** Round dealt. */
    deal() {
      for (let i = 0; i < 4; i++) this.noise({ dur: 0.07, gain: 0.07, from: 1200 + i * 250, to: 2600, delay: i * 0.06 });
    }

    error() {
      this.tone({ freq: 300, to: 200, dur: 0.18, type: 'sawtooth', gain: 0.08 });
    }
  }

  window.UNOSfx = new Sfx();
})();
