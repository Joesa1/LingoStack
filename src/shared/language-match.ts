/**
 * "Is this text already in the target language" comparison, shared by the
 * subtitle passthrough check (subtitles/subtitle-session.ts) and the page
 * language filter (content-scripts/language-filter.ts).
 *
 * Default rule: compare primary subtags only (`en-US` ~ `en-GB`). Chinese is
 * a documented exception — the popup exposes Simplified (`zh-CN`/`zh-Hans`)
 * and Traditional (`zh-TW`/`zh-HK`/`zh-Hant`) as distinct targets, so
 * collapsing them to the shared `zh` primary subtag would silently leave a
 * Simplified source passed through unchanged against a Traditional target
 * (and vice versa). A bare `zh` tag (no script/region) carries no script
 * information, so it is treated as matching either script — the same
 * permissive behavior as before this module existed — rather than guessing
 * wrong.
 *
 * Based on: docs/packages/web-translate/README.md §7.9, §7.1 rule 6 (D9, D17)
 */
function primarySubtag(lang: string): string {
  return lang.toLowerCase().split("-")[0] ?? lang.toLowerCase()
}

const ZH_HANS_SUBTAGS = new Set(["cn", "sg", "hans"])
const ZH_HANT_SUBTAGS = new Set(["tw", "hk", "mo", "hant"])

/** Chinese script implied by any subtag after the primary one, or `undefined` when the tag carries no script info. */
function chineseScript(lang: string): "hans" | "hant" | undefined {
  for (const subtag of lang.toLowerCase().split("-").slice(1)) {
    if (ZH_HANS_SUBTAGS.has(subtag)) return "hans"
    if (ZH_HANT_SUBTAGS.has(subtag)) return "hant"
  }
  return undefined
}

/** Whether `a` and `b` should be treated as the same language for passthrough/filter decisions. */
export function languagesMatch(a: string, b: string): boolean {
  const primaryA = primarySubtag(a)
  const primaryB = primarySubtag(b)
  if (primaryA !== primaryB) return false
  if (primaryA !== "zh") return true
  const scriptA = chineseScript(a)
  const scriptB = chineseScript(b)
  if (scriptA === undefined || scriptB === undefined) return true // no script info to disagree on
  return scriptA === scriptB
}
