/**
 * Single source of truth for text normalization: the content-script walker
 * (T8, `sourceText` extraction) and the background cache (T7, cache key
 * input) MUST agree on this, or identical page text produces different cache
 * keys depending on where it was normalized.
 *
 * Only U+200B (zero-width space) and U+FEFF (BOM) are stripped — they're
 * not whitespace so `\s+` doesn't collapse them, but they're invisible
 * layout hints that would otherwise get sent to the translation model and
 * rendered back verbatim for no reason. U+200C (ZWNJ) and U+200D (ZWJ) are
 * KEPT: ZWJ joins composite emoji (👨‍👩‍👧 is three code points joined
 * by ZWJ — stripping it decomposes the family into separate glyphs), and
 * ZWNJ is orthographic in Persian and other scripts (stripping it corrupts
 * the word).
 *
 * Based on: docs/packages/web-translate/README.md §7.1 ("sourceText 提取时折叠空白，与 cache 归一化一致")
 */
const ZERO_WIDTH_CHARS_RE = /[\u200B\uFEFF]/g

export function normalizeText(text: string): string {
  return text.replace(ZERO_WIDTH_CHARS_RE, "").replace(/\s+/g, " ").trim()
}
