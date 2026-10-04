/* Celebration effects.
 *
 * One <canvas>, one requestAnimationFrame loop, one pooled array of particles.
 * Deliberately not DOM elements: a confetti burst of 120 divs would cost 120
 * layout/paint objects and stall a low-end Android exactly when the player is
 * most likely to be watching. On a canvas the same burst is one composited
 * layer and one draw call.
 *
 * The loop only runs while particles exist, and stops completely when the
 * effect is over, so an idle table costs nothing.
 */

(() => {
  'use strict';

  const COLORS = ['#e63946', '#f4a300', '#2a9d5c', '#2f6fd0', '#f2f5f4', '#ff8f8f'];

  class Particles {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.items = [];
      this.raf = null;
      this.dpr = 1;
      this.resize();
      this._onResize = () => this.resize();
      window.addEventListener('resize', this._onResize, { passive: true });
      window.addEventListener('orientationchange', this._onResize, { passive: true });
    }

    resize() {
      // Match the backing store to the device pixel ratio, then scale the
      // context back down so drawing code can work in CSS pixels.
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = this.canvas.clientWidth || window.innerWidth;
      const h = this.canvas.clientHeight || window.innerHeight;
      this.canvas.width = Math.floor(w * this.dpr);
      this.canvas.height = Math.floor(h * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.w = w;
      this.h = h;
    }

    get count() {
      return this.items.length;
    }

    spawn(n, factory) {
      for (let i = 0; i < n; i++) this.items.push(factory(i, this.items.length));
      this.start();
    }

    start() {
      if (this.raf !== null) return;
      let last = performance.now();
      const step = (now) => {
        // Clamp dt so a backgrounded tab does not teleport every particle
        // off-screen the frame it comes back.
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        this.draw(dt);
        if (this.items.length) {
          this.raf = requestAnimationFrame(step);
        } else {
          this.raf = null;
          this.ctx.clearRect(0, 0, this.w, this.h);
        }
      };
      this.raf = requestAnimationFrame(step);
    }

    draw(dt) {
      const { ctx, w, h } = this;
      ctx.clearRect(0, 0, w, h);

      for (let i = this.items.length - 1; i >= 0; i--) {
        const p = this.items[i];
        p.life -= dt;
        if (p.life <= 0) {
          this.items.splice(i, 1);
          continue;
        }

        p.vy += p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.spin * dt;
        // Drag: air resistance, so confetti flutters instead of dropping like sand.
        p.vx *= 1 - p.drag * dt;

        const alpha = Math.min(1, p.life / p.fade);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.shape === 'rect') ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    /** Full-screen confetti for a win. Count scales with the viewport. */
    confetti({ originY = 0.35 } = {}) {
      const area = this.w * this.h;
      const n = Math.round(Math.min(150, Math.max(50, area / 9000)));
      this.spawn(n, () => {
        const fromLeft = Math.random() < 0.5;
        const x = fromLeft ? -10 : this.w + 10;
        return {
          x,
          y: this.h * originY + (Math.random() - 0.5) * 60,
          vx: (fromLeft ? 1 : -1) * (180 + Math.random() * 320),
          vy: -(120 + Math.random() * 280),
          gravity: 620,
          drag: 1.1,
          rot: Math.random() * Math.PI,
          spin: (Math.random() - 0.5) * 9,
          size: 7 + Math.random() * 7,
          shape: 'rect',
          color: COLORS[(Math.random() * COLORS.length) | 0],
          life: 1.6 + Math.random() * 1.1,
          fade: 0.7,
        };
      });
    }

    /** A tight upward burst, for a single player's moment. */
    burst(x, y, { n = 34, spread = 260, color = null } = {}) {
      this.spawn(n, () => {
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * (spread / 180) * Math.PI;
        const speed = 200 + Math.random() * 320;
        return {
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          gravity: 720,
          drag: 1.6,
          rot: 0,
          spin: (Math.random() - 0.5) * 12,
          size: 6 + Math.random() * 6,
          shape: Math.random() < 0.5 ? 'rect' : 'circle',
          color: color || COLORS[(Math.random() * COLORS.length) | 0],
          life: 0.8 + Math.random() * 0.5,
          fade: 0.45,
        };
      });
    }

    destroy() {
      if (this.raf !== null) cancelAnimationFrame(this.raf);
      this.raf = null;
      this.items.length = 0;
      window.removeEventListener('resize', this._onResize);
      window.removeEventListener('orientationchange', this._onResize);
    }
  }

  window.UNOParticles = Particles;
})();
