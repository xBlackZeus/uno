/* UNO card artwork, drawn as inline SVG.
 *
 * Rendered rather than loaded as images so every card is crisp at any size,
 * needs no network request, and can be recoloured or restyled from CSS
 * variables. Faces echo the classic look: cream stock, a thick border in the
 * card colour, a colour oval in the middle and corner pips.
 */

(() => {
  'use strict';

  const FACE = '#faf6ec';
  const INK = '#1b1b1f';
  const COLOR = {
    R: '#e63946',
    Y: '#f2b705',
    G: '#1f9d55',
    B: '#2f6fd0',
  };
  const NAME = { R: 'Red', Y: 'Yellow', G: 'Green', B: 'Blue' };

  // White reads poorly on yellow, so those cards get dark text.
  const onColor = (c) => (c === 'Y' ? INK : '#ffffff');

  const NS = 'http://www.w3.org/2000/svg';
  let uid = 0; // keeps clip-path ids unique across cards on one screen
  const svg = (tag, attrs = {}) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };

  const text = (content, attrs) => {
    const node = svg('text', attrs);
    node.textContent = content;
    return node;
  };

  /** The colour a card is drawn in; a wild answers to the colour it was called. */
  function colorOf(card) {
    return card.color === 'W' ? card.chosen || 'W' : card.color;
  }

  function glyphFor(card) {
    if (card.kind === 'num') return String(card.num);
    if (card.kind === 'draw2') return '+2';
    if (card.kind === 'skip') return 'skip';
    if (card.kind === 'rev') return 'rev';
    if (card.kind === 'wild') return 'WILD';
    return '+4';
  }

  /** Small mark used in the two corners. */
  function cornerMark(card) {
    const g = glyphFor(card);
    if (g === 'skip') return '⊘';
    if (g === 'rev') return '⇄';
    return g;
  }

  function cornerPips(card) {
    const color = COLOR[colorOf(card)];
    const fill = onColor(colorOf(card));
    const mark = cornerMark(card);
    const big = mark.length > 2;

    const pip = (transform) => {
      const g = svg('g', transform ? { transform } : {});
      g.append(
        svg('rect', { x: 11, y: 10, width: 30, height: 24, rx: 8, fill: color }),
        text(mark, {
          x: 26,
          y: 22,
          fill,
          'text-anchor': 'middle',
          'dominant-baseline': 'central',
          'font-size': big ? 11 : 16,
          'font-weight': 800,
          'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }),
      );
      return g;
    };

    // Both pips read upright. Turning one over makes a 7 look like an L.
    return [pip(null), pip('translate(48 100)')];
  }

  /** The symbol in the middle of the card. */
  function centreMark(card) {
    const color = COLOR[colorOf(card)];
    const fill = onColor(colorOf(card));
    const g = svg('g');
    const mark = glyphFor(card);

    if (card.kind === 'num' || card.kind === 'draw2' || card.kind === 'wild4') {
      g.append(svg('ellipse', { cx: 50, cy: 70, rx: 33, ry: 31, fill: color }));
      g.append(
        text(mark, {
          x: 50,
          y: 72,
          fill,
          'text-anchor': 'middle',
          'dominant-baseline': 'central',
          'font-size': mark.length > 1 ? 26 : 40,
          'font-weight': 800,
          'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }),
      );
      return g;
    }

    if (card.kind === 'skip') {
      const id = `skip-${uid++}`;
      g.append(svg('circle', { cx: 50, cy: 70, r: 30, fill: color }));
      // A prohibition sign: the bar has to stop at the edge of the circle.
      const clip = svg('clipPath', { id });
      clip.append(svg('circle', { cx: 50, cy: 70, r: 30 }));
      const defs = svg('defs');
      defs.append(clip);
      const bar = svg('rect', {
        x: 14,
        y: 65, // centred on the card, so rotating about (50,70) keeps it centred
        width: 72, // longer than the circle; the clip trims it to the edge
        height: 10,
        fill,
        transform: 'rotate(-45 50 70)',
        'clip-path': `url(#${id})`,
      });
      g.append(defs, bar);
      return g;
    }

    if (card.kind === 'rev') {
      g.append(svg('ellipse', { cx: 50, cy: 70, rx: 33, ry: 31, fill: color }));
      // Two arrows chasing each other, which is what reverse means.
      g.append(
        svg('path', { d: 'M 30 51 H 58 V 44 L 74 57 L 58 70 V 63 H 30 Z', fill }),
        svg('path', { d: 'M 70 77 H 42 V 70 L 26 83 L 42 96 V 89 H 70 Z', fill }),
      );
      return g;
    }

    return g;
  }

  /** Wilds: a dark card showing all four colours, with the name across a band. */
  function wildFace(card) {
    const g = svg('g');
    const panels = [
      [8, 8, COLOR.R],
      [50, 8, COLOR.B],
      [8, 76, COLOR.Y],
      [50, 76, COLOR.G],
    ];
    for (const [x, y, fill] of panels) {
      g.append(svg('rect', { x, y, width: 42, height: 56, rx: 10, fill }));
    }
    g.append(
      svg('rect', { x: 13, y: 55, width: 74, height: 30, rx: 15, fill: FACE, stroke: INK, 'stroke-width': 2.5 }),
      text(card.kind === 'wild4' ? 'WILD +4' : 'WILD', {
        x: 50,
        y: 71,
        fill: INK,
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        'font-size': card.kind === 'wild4' ? 14 : 16,
        'font-weight': 800,
        'letter-spacing': '0.4',
      }),
    );
    return g;
  }

  /**
   * Builds one card face.
   * @param {object} card  { color, kind, num, chosen }
   * @param {object} [opts]
   */
  function cardSvg(card, opts = {}) {
    const root = svg('svg', {
      viewBox: '0 0 100 140',
      class: 'card-art',
      role: 'img',
      'aria-label': describe(card),
    });

    const isWild = card.color === 'W';
    const color = colorOf(card);

    root.append(
      svg('rect', {
        x: 0,
        y: 0,
        width: 100,
        height: 140,
        rx: 13,
        fill: isWild ? INK : FACE,
        stroke: isWild ? FACE : COLOR[color],
        'stroke-width': 9,
      }),
    );

    if (isWild) {
      root.append(wildFace(card));
    } else {
      root.append(...cornerPips(card), centreMark(card));
    }

    // A subtle sheen so the stock does not look flat.
    root.append(
      svg('path', {
        d: 'M 12 6 L 88 6 L 12 96 Z',
        fill: '#ffffff',
        opacity: 0.09,
      }),
    );

    if (opts.mini) root.classList.add('mini');
    return root;
  }

  /** The back of a card: four colours meeting in the middle. */
  function backSvg() {
    const root = svg('svg', {
      viewBox: '0 0 100 140',
      class: 'card-art',
      'aria-label': 'Face-down card',
      role: 'img',
    });
    root.append(
      svg('rect', { x: 0, y: 0, width: 100, height: 140, rx: 13, fill: '#141821', stroke: '#2b3242', 'stroke-width': 5 }),
    );

    // One blade per colour, all meeting at the centre.
    const blades = [
      { fill: COLOR.R, d: 'M 50 70 L 9 9 L 9 70 Z' },
      { fill: COLOR.B, d: 'M 50 70 L 91 9 L 91 70 Z' },
      { fill: COLOR.G, d: 'M 50 70 L 9 131 L 9 70 Z' },
      { fill: COLOR.Y, d: 'M 50 70 L 91 131 L 91 70 Z' },
    ];
    for (const b of blades) root.append(svg('path', { d: b.d, fill: b.fill }));

    root.append(
      svg('circle', { cx: 50, cy: 70, r: 30, fill: '#141821' }),
      svg('circle', { cx: 50, cy: 70, r: 30, fill: 'none', stroke: '#faf6ec', 'stroke-width': 2, opacity: 0.85 }),
      text('UNO', {
        x: 50,
        y: 71,
        fill: '#ffffff',
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        'font-size': 17,
        'font-weight': 900,
        'letter-spacing': '1.5',
      }),
    );
    return root;
  }

  function describe(card) {
    if (card.color === 'W') return card.kind === 'wild4' ? 'Wild Draw Four card' : 'Wild card';
    const n = NAME[card.color];
    if (card.kind === 'num') return `${n} ${card.num}`;
    if (card.kind === 'skip') return `${n} Skip`;
    if (card.kind === 'rev') return `${n} Reverse`;
    return `${n} Draw Two`;
  }

  window.UNOCards = { cardSvg, backSvg, describe, COLOR, NAME };
})();