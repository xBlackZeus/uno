/* Stickers.
 *
 * Deliberately not images. An image sticker is tens of kilobytes that every
 * player downloads; a glyph sticker is a few bytes of a short id, so a table
 * can spam them all day on almost no data. Custom stickers are therefore added
 * by picking from this built-in set rather than uploading a picture — an upload
 * would need storage and would be re-sent to every player.
 */

(() => {
  'use strict';

  const STICKERS = [
    { id: 'laugh', glyph: '😂', name: 'laughing' },
    { id: 'lol', glyph: '🤣', name: 'rofl' },
    { id: 'smile', glyph: '😄', name: 'smile' },
    { id: 'cool', glyph: '😎', name: 'cool' },
    { id: 'wink', glyph: '😉', name: 'wink' },
    { id: 'heart', glyph: '❤️', name: 'heart' },
    { id: 'thinking', glyph: '🤔', name: 'thinking' },
    { id: 'cry', glyph: '😭', name: 'crying' },
    { id: 'angry', glyph: '😤', name: 'frustrated' },
    { id: 'sleepy', glyph: '😴', name: 'sleepy' },
    { id: 'sick', glyph: '🤢', name: 'sick' },
    { id: 'eyes', glyph: '👀', name: 'watching' },
    { id: 'fire', glyph: '🔥', name: 'fire' },
    { id: 'clap', glyph: '👏', name: 'clap' },
    { id: 'thumbsup', glyph: '👍', name: 'nice' },
    { id: 'thumbsdown', glyph: '👎', name: 'no' },
    { id: 'rocket', glyph: '🚀', name: 'lucky' },
    { id: 'trophy', glyph: '🏆', name: 'winner' },
    { id: 'uno', glyph: '🃏', name: 'uno' },
    { id: 'sweat', glyph: '😅', name: 'nervous' },
    { id: 'zany', glyph: '🤪', name: 'zany' },
    { id: 'dead', glyph: '💀', name: 'brutal' },
    { id: 'shrug', glyph: '🤷', name: 'shrug' },
    { id: 'ok', glyph: '👌', name: 'ok' },
  ];

  const BY_ID = new Map(STICKERS.map((s) => [s.id, s]));

  /** Unknown ids are simply not drawn, never sent raw to another player. */
  const glyph = (id) => BY_ID.get(String(id || ''))?.glyph ?? '❔';

  window.UNOStickers = { STICKERS, glyph, has: (id) => BY_ID.has(id) };
})();