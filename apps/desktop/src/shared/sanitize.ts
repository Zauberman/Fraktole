/** Chat-text sanitation: chat surfaces (reviewer transcript, tool results,
 *  orchestrator message log) must never render emoji. Emoji-only stripping —
 *  arrows (2190-21FF), CJK, accents and the app's own chrome survive.
 *  Terminal tiles are never sanitized: real terminal output stays raw. */

// The emoji codepoints (ranges + stragglers). ZWJ (U+200D) is deliberately
// NOT in the class: it is removed only as part of an emoji sequence below, so
// Arabic/Indic text that uses ZWJ for required glyph joining stays intact.
const EMOJI_RANGE = String.raw`\u{1F000}-\u{1FAFF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2934}-\u{2935}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{FE0F}\u{20E3}\u{2B50}\u{2764}\u{2728}`;

/** An emoji plus any ZWJ-joined emoji tail (families, professions, flags…),
 *  stripped as one unit so no bare ZWJ is left behind. */
// eslint-disable-next-line no-misleading-character-class
const EMOJI_RE = new RegExp(`[${EMOJI_RANGE}](?:\\u{200D}[${EMOJI_RANGE}])*`, 'gu');

/** Removes emoji: pictographs, dingbats, flags, keycaps, variation
 *  selectors, ZWJ sequences and the common single-codepoint emoji. */
export function stripEmoji(text: string): string {
  return text.replace(EMOJI_RE, '');
}

/** Full chat-text sanitization: emoji plus zero-width / bidi marks (including
 *  the bidi OVERRIDE characters used for spoofing) and stray control
 *  characters (tabs, newlines and carriage returns kept). */
export function sanitizeChatText(text: string): string {
  return stripEmoji(text)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g, '');
}
