/**
 * Async language filter over collected units (D9): the final arbiter of "is
 * this text already in the target language". The walker's sync guess only
 * fast-skips provable CJK-script matches; everything it emits passes through
 * here before submission, backed by `chrome.i18n.detectLanguage` (Chrome's
 * built-in local CLD — no network, no extra permission).
 *
 * A unit is dropped ONLY when detection is reliable AND the top detected
 * language matches the target (see `languagesMatch`, ../shared/language-match.ts
 * — primary subtag, with a Simplified/Traditional Chinese script exception).
 * Every other outcome — unreliable result, unknown language, detect throwing
 * (the API is unavailable in some contexts) — fails open and keeps the unit,
 * so a non-target-language text is never silently left untranslated.
 *
 * Dropped units are marked `data-lingo-tr-state="done"` on their element: the
 * walker's rule 7 (done + unchanged hash) then skips them on re-walks, and
 * `restoreAll` clears the marks like any other unit's.
 *
 * Based on: docs/packages/web-translate/README.md §7.1 rule 6, D9
 */
import type { TranslationUnit } from "./walker"

import { languagesMatch } from "../shared/language-match"

/** Shape of one `chrome.i18n.detectLanguage` result. */
export type DetectedLanguageResult = {
  isReliable: boolean
  languages: { language: string; percentage: number }[]
}

export type DetectLanguage = (text: string) => Promise<DetectedLanguageResult>

export type LanguageFilter = {
  /** Returns the units that still need translation; marks dropped ones as done. */
  filterUnits(units: TranslationUnit[], targetLang: string): Promise<TranslationUnit[]>
}

export function createLanguageFilter(deps: { detect: DetectLanguage }): LanguageFilter {
  async function isTargetLanguage(text: string, targetLang: string): Promise<boolean> {
    let result: DetectedLanguageResult
    try {
      result = await deps.detect(text)
    } catch {
      return false // detect unavailable — fail open, translate
    }
    if (!result.isReliable) return false
    const top = result.languages[0]
    if (top === undefined) return false
    return languagesMatch(top.language, targetLang)
  }

  return {
    async filterUnits(units, targetLang) {
      const verdicts = await Promise.all(units.map((unit) => isTargetLanguage(unit.sourceText, targetLang)))
      const kept: TranslationUnit[] = []
      units.forEach((unit, i) => {
        if (verdicts[i] === true) {
          unit.element.setAttribute("data-lingo-tr-state", "done")
        } else {
          kept.push(unit)
        }
      })
      return kept
    },
  }
}

/**
 * The real-runtime detect function. `chrome.i18n.detectLanguage` exists in
 * every MV3 content script; the guard covers non-extension contexts (tests,
 * a future non-Chrome build) by failing open via the filter's catch.
 */
export function chromeDetectLanguage(text: string): Promise<DetectedLanguageResult> {
  if (typeof chrome === "undefined" || chrome.i18n?.detectLanguage === undefined) {
    return Promise.reject(new Error("chrome.i18n.detectLanguage unavailable"))
  }
  return chrome.i18n.detectLanguage(text)
}
