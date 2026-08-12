import { describe, expect, it } from 'vitest';
import { sanitizeChatText, stripEmoji } from '../src/shared/sanitize.js';

describe('stripEmoji', () => {
  it('removes pictographs and their variation-selector variants', () => {
    expect(stripEmoji('ok ✅')).toBe('ok ');
    expect(stripEmoji('smile ☺️')).toBe('smile ');
    expect(stripEmoji('rocket 🚀 launch')).toBe('rocket  launch');
    expect(stripEmoji('sparkles ✨')).toBe('sparkles ');
    expect(stripEmoji('heart ❤️')).toBe('heart ');
  });

  it('removes flags and ZWJ sequences as a unit', () => {
    expect(stripEmoji('🇫🇷 france')).toBe(' france');
    expect(stripEmoji('family 👨‍👩‍👧')).toBe('family ');
    expect(stripEmoji('coder 👨‍💻')).toBe('coder ');
  });

  it('removes keycap sequences (the digits themselves are ASCII and survive)', () => {
    expect(stripEmoji('score 10️⃣')).toBe('score 10');
  });

  it('removes dingbats and misc symbols', () => {
    expect(stripEmoji('star ⭐')).toBe('star ');
    expect(stripEmoji('check ✅ done')).toBe('check  done');
  });

  it('keeps arrows, CJK, accents and ASCII', () => {
    expect(stripEmoji('a → b')).toBe('a → b');
    expect(stripEmoji('中文文本')).toBe('中文文本');
    expect(stripEmoji('café résumé')).toBe('café résumé');
    expect(stripEmoji('$ ls -la /tmp')).toBe('$ ls -la /tmp');
  });
});

describe('sanitizeChatText', () => {
  it('strips emoji plus zero-width and bidi marks', () => {
    expect(sanitizeChatText('a\u200Bb\u200Cc\u2060d\uFEFFe ✅')).toBe('abcde ');
  });

  it('drops stray control characters but keeps tab/newline/cr', () => {
    expect(sanitizeChatText('a\x00b\x1Fc')).toBe('abc');
    expect(sanitizeChatText('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('is idempotent', () => {
    const once = sanitizeChatText('done ✅\u200B\nnext');
    expect(sanitizeChatText(once)).toBe(once);
  });
});
