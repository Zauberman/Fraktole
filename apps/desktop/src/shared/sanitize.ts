/** Chat-text sanitation: chat surfaces (reviewer transcript, tool results,
 *  orchestrator message log) must never render emoji. Emoji-only stripping —
 *  arrows (2190-21FF), CJK, accents and the app's own chrome survive.
 *  Terminal tiles are never sanitized: real terminal output stays raw. */

const EMOJI_RE =
  // eslint-disable-next-line no-misleading-character-class
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}\u{2B50}\u{2764}\u{2728}]/gu;

/** Removes emoji: pictographs, dingbats, flags, keycaps, variation
 *  selectors, ZWJ sequences and the common single-codepoint emoji. */
export function stripEmoji(text: string): string {
  return text.replace(EMOJI_RE, '');
}

/** Full chat-text sanitization: emoji plus zero-width / bidi marks and
 *  stray control characters (tabs, newlines and carriage returns kept). */
export function sanitizeChatText(text: string): string {
  return stripEmoji(text)
    .replace(/[\u200B\u200C\u2060\uFEFF]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}
