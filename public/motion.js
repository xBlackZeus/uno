/* Motion.
 *
 * One place for "how things move", so timings stay consistent instead of every
 * effect inventing its own duration and easing. Durations are deliberately in
 * the 120-420ms band: long enough to read as physical, short enough that a
 * fast game never feels like it is waiting on decoration.
 *
 * Two rules this file exists to enforce:
 *   1. Animate only `transform` and `opacity`. Those are handled by the
 *      compositor and never trigger layout, which is what keeps a mid-range
 *      Android from dropping frames mid-turn.
 *   2. Honour prefers-reduced-motion. Not by disabling feedback — by replacing
 *      movement with an instant, equally legible state change.
 */

(() => {
  'use strict';

  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  const Motion = {
    /** Durations in ms. Kept in one table so the whole app feels coherent. */
    duration: {
      instant: 90,
      fast: 150,
      base: 240,
      slow: 340,
      celebrate: 700,
    },

    ease: {
      out: 'cubic-bezier(0.22, 1, 0.36, 1)',
      inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
      spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    },

    get reduced() {
      return reduceQuery.matches;
    },

    /** Fires when the preference flips, so live state can be re-rendered. */
    onPreferenceChange(fn) {
      const handler = () => fn(reduceQuery.matches);
      reduceQuery.addEventListener?.('change', handler);
      return () => removeEventListener('change', handler);
    },

    /**
     * Runs `fn` unless motion is reduced, in which case runs it immediately.
     * Used at every call site so no effect can forget the check.
     */
    unlessReduced(fn, instantFn) {
      if (this.reduced) {
        instantFn?.();
        return;
      }
      fn();
    },

    /** Restarts a CSS animation on an element that may already have the class. */
    replay(node, className) {
      if (!node) return;
      node.classList.remove(className);
      // Reading offsetWidth flushes the removal, so re-adding restarts cleanly.
      void node.offsetWidth;
      node.classList.add(className);
    },

    /**
     * Flies a cloned card from wherever it is to a target element.
     *
     * FLIP: measure First, measure Last, then Invert with a transform and Play
     * it back to identity. The card on the table is untouched, so the game's
     * own DOM stays authoritative and nothing has to be undone afterwards.
     */
    flyCard(sourceEl, targetEl, { duration, rotate = -6, scale = 1, className = '' } = {}) {
      if (!sourceEl || !targetEl || this.reduced) return;

      const from = sourceEl.getBoundingClientRect();
      const to = targetEl.getBoundingClientRect();
      if (!from.width || !to.width) return;

      const ghost = sourceEl.cloneNode(true);
      ghost.classList.add('card-ghost');
      if (className) ghost.classList.add(className);
      // Fixed positioning against the viewport is what makes the maths correct
      // regardless of where the two elements sit in the layout.
      Object.assign(ghost.style, {
        position: 'fixed',
        left: `${from.left}px`,
        top: `${from.top}px`,
        width: `${from.width}px`,
        height: `${from.height}px`,
        margin: '0',
        zIndex: '60',
        pointerEvents: 'none',
      });

      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      const ms = duration ?? this.duration.base;

      const anim = ghost.animate(
        [
          { transform: 'translate(0, 0) scale(1) rotate(0deg)', opacity: 1 },
          {
            transform: `translate(${dx}px, ${dy}px) scale(${scale}) rotate(${rotate}deg)`,
            opacity: 0.15,
            offset: 0.82,
          },
          { transform: `translate(${dx}px, ${dy}px) scale(${scale * 0.9}) rotate(${rotate}deg)`, opacity: 0 },
        ],
        { duration: ms, easing: this.ease.inOut, fill: 'forwards' },
      );

      document.body.append(ghost);
      anim.finished
        .catch(() => {})
        .then(() => {
          ghost.remove();
        });
    },

    /**
     * Flies a card from a remembered rectangle to a target element.
     *
     * Needed because the server confirms a move after the fact: by the time the
     * new state arrives, the card has already left the hand and its DOM node is
     * gone. So the click records where the card *was*, and this replays the
     * movement from that spot.
     */
    flyFromRect(rect, targetEl, { duration, rotate = -8, html = null, className = '' } = {}) {
      if (!rect || !targetEl || this.reduced) return;
      const to = targetEl.getBoundingClientRect();
      if (!to.width) return;

      const ghost = document.createElement('div');
      ghost.className = `card-ghost ${className}`.trim();
      if (html) ghost.innerHTML = html;
      Object.assign(ghost.style, {
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        margin: '0',
        zIndex: '60',
        pointerEvents: 'none',
      });

      const dx = to.left + to.width / 2 - (rect.left + rect.width / 2);
      const dy = to.top + to.height / 2 - (rect.top + rect.height / 2);
      const ms = duration ?? this.duration.base;

      const anim = ghost.animate(
        [
          { transform: 'translate(0, 0) scale(1) rotate(0deg)', opacity: 1 },
          {
            transform: `translate(${dx}px, ${dy * 0.55}px) scale(1.08) rotate(${rotate / 2}deg)`,
            opacity: 1,
            offset: 0.55,
          },
          { transform: `translate(${dx}px, ${dy}px) scale(0.94) rotate(${rotate}deg)`, opacity: 0.2 },
        ],
        { duration: ms, easing: this.ease.inOut, fill: 'forwards' },
      );

      document.body.append(ghost);
      anim.finished
        .catch(() => {})
        .then(() => ghost.remove());
    },

    /** Draws a card out of the deck towards the hand. Same FLIP trick, opposite
     *  direction, with a small arc so it reads as a flick rather than a slide. */
    flyFromPile(pileEl, targetEl, opts = {}) {
      if (!pileEl || !targetEl || this.reduced) return;
      const from = pileEl.getBoundingClientRect();
      const to = targetEl.getBoundingClientRect();
      if (!from.width || !to.width) return;

      const ghost = pileEl.cloneNode(true);
      ghost.classList.add('card-ghost', 'is-drawing');
      Object.assign(ghost.style, {
        position: 'fixed',
        left: `${from.left}px`,
        top: `${from.top}px`,
        width: `${from.width}px`,
        height: `${from.height}px`,
        margin: '0',
        zIndex: '60',
        pointerEvents: 'none',
      });

      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      // Lift the midpoint so the path bows instead of running dead straight.
      const lift = Math.min(70, Math.abs(dy) * 0.35);

      const anim = ghost.animate(
        [
          { transform: 'translate(0, 0) rotate(0deg)', opacity: 0.9 },
          { transform: `translate(${dx / 2}px, ${dy / 2 - lift}px) rotate(9deg)`, opacity: 1, offset: 0.5 },
          { transform: `translate(${dx}px, ${dy}px) rotate(0deg)`, opacity: 0.9 },
        ],
        { duration: opts.duration ?? this.duration.base, easing: this.ease.out },
      );

      document.body.append(ghost);
      anim.finished
        .catch(() => {})
        .then(() => ghost.remove());
    },

    /** One-shot attention shake. Used for an illegal move. */
    shake(node, { strength = 6, duration = 260 } = {}) {
      if (!node) return;
      if (this.reduced) {
        // No movement, but still a visible acknowledgement.
        node.classList.add('is-nope');
        setTimeout(() => node.classList.remove('is-nope'), Motion.duration.base);
        return;
      }
      const anim = node.animate(
        [
          { transform: 'translateX(0)' },
          { transform: `translateX(${-strength}px)` },
          { transform: `translateX(${strength}px)` },
          { transform: `translateX(${-strength / 2}px)` },
          { transform: 'translateX(0)' },
        ],
        { duration, easing: 'ease-in-out' },
      );
      anim.finished.catch(() => {});
    },
  };

  window.UNOMotion = Motion;
})();
