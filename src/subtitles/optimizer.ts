/**
 * Heuristic sentence assembly: merge raw seg-level cues into readable
 * sentence-ish cues (punctuation / >1s pause / length cap boundaries), with a
 * second pass that rebalances too-short lines into a target length range.
 * Pure JS — the LLM never segments in this port (D17: no AI segmentation).
 *
 * Based on: docs/packages/web-translate/README.md §7.9 (D17).
 */
import type { SubtitleCue } from "./types"

import { SENTENCE_END_PATTERN, getMaxLength, getTextLength, isCjkLanguage } from "./json3-parser"

export const PAUSE_TIMEOUT_MS = 1_000

const QUALITY_LENGTH_THRESHOLD = 250
const QUALITY_PERCENTAGE_THRESHOLD = 0.2
const STARTS_WITH_SIGN_PATTERN = /^[[(♪]/

const TARGET_MIN_CJK = 15
const TARGET_MAX_CJK = 25
const TARGET_MIN_NON_CJK = 11
const TARGET_MAX_NON_CJK = 20

// YouTube's timed-text segments are display fragments, not sentence
// boundaries. Keep a wider semantic window here so an English clause split
// across two short cues is translated and spoken as one unit. The target
// range below still folds very short cues, while this limit only prevents
// genuinely long paragraphs from becoming one request.
const SEMANTIC_MAX_CJK = 60
const SEMANTIC_MAX_NON_CJK = 32

/** Filler words that often open a new spoken clause — used only in the aggressive second pass. */
const PAUSE_WORDS = new Set([
  "actually", "also", "although", "and", "anyway", "as", "basically", "because", "but",
  "eventually", "frankly", "honestly", "hopefully", "however", "if", "instead", "just",
  "like", "literally", "maybe", "meanwhile", "nevertheless", "nonetheless", "now", "okay",
  "or", "otherwise", "perhaps", "personally", "probably", "right", "since", "so",
  "suddenly", "then", "therefore", "though", "thus", "unless", "until", "well", "while",
])

const LEADING_CHEVRON_PATTERN = /^>>\s*/
const CHEVRON_PATTERN = />>/g

function cleanText(text: string): string {
  return text.replace(LEADING_CHEVRON_PATTERN, "").replace(CHEVRON_PATTERN, " ").trim()
}

function getFirstWord(text: string): string {
  return text.toLowerCase().split(/\s+/)[0] ?? ""
}

function isQualityPoor(cues: SubtitleCue[]): boolean {
  if (cues.length === 0) return false
  const longCount = cues.filter((c) => c.text.length > QUALITY_LENGTH_THRESHOLD).length
  return longCount / cues.length > QUALITY_PERCENTAGE_THRESHOLD
}

function processCues(cues: SubtitleCue[], language: string, usePause: boolean, semantic = true): SubtitleCue[] {
  const result: SubtitleCue[] = []
  const buffer: SubtitleCue[] = []
  let bufferLength = 0
  const isCjk = isCjkLanguage(language)
  const separator = isCjk ? "" : " "
  const maxLength = semantic ? Math.max(getMaxLength(isCjk), isCjk ? SEMANTIC_MAX_CJK : SEMANTIC_MAX_NON_CJK) : getMaxLength(isCjk)

  const flushBuffer = (): void => {
    const first = buffer[0]
    const last = buffer.at(-1)
    if (first === undefined || last === undefined) return
    result.push({
      text: buffer.map((s) => s.text).join(separator).trim(),
      start: first.start,
      end: last.end,
    })
    buffer.length = 0
    bufferLength = 0
  }

  for (const cue of cues) {
    if (cue.text.length === 0) continue
    const text = cleanText(cue.text)
    if (text.length === 0) continue
    const cueLength = getTextLength(text, isCjk)
    const lastSegment = buffer.at(-1)

    if (lastSegment !== undefined) {
      const isEndOfSentence = SENTENCE_END_PATTERN.test(lastSegment.text)
      const isTimeout = cue.start - lastSegment.end > PAUSE_TIMEOUT_MS
      const wouldExceedLimit = bufferLength + cueLength > maxLength
      const startsWithSign = STARTS_WITH_SIGN_PATTERN.test(cue.text)
      const startsWithPauseWord = usePause && PAUSE_WORDS.has(getFirstWord(cue.text)) && buffer.length > 1

      if (isEndOfSentence || isTimeout || wouldExceedLimit || startsWithSign || startsWithPauseWord) {
        flushBuffer()
      }
    }

    buffer.push({ text, start: cue.start, end: cue.end })
    bufferLength += cueLength
  }

  flushBuffer()
  return result
}

function mergeCuePair(left: SubtitleCue, right: SubtitleCue, separator: string): SubtitleCue {
  return { ...left, text: `${left.text}${separator}${right.text}`.trim(), end: right.end }
}

function shouldKeepBoundary(left: SubtitleCue, right: SubtitleCue): boolean {
  return right.start - left.end > PAUSE_TIMEOUT_MS || STARTS_WITH_SIGN_PATTERN.test(right.text)
}

function rebalanceToTargetRange(cues: SubtitleCue[], language: string): SubtitleCue[] {
  if (cues.length <= 1) return cues

  const isCjk = isCjkLanguage(language)
  const separator = isCjk ? "" : " "
  const min = isCjk ? TARGET_MIN_CJK : TARGET_MIN_NON_CJK
  const max = isCjk ? TARGET_MAX_CJK : TARGET_MAX_NON_CJK

  const result: SubtitleCue[] = []

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]
    if (cue === undefined) continue
    let current = { ...cue }
    let currentLength = getTextLength(current.text, isCjk)

    while (currentLength < min && i + 1 < cues.length) {
      const next = cues[i + 1]
      if (next === undefined) break
      const combinedLength = currentLength + getTextLength(next.text, isCjk)
      if (combinedLength > max || shouldKeepBoundary(current, next)) break
      current = mergeCuePair(current, next, separator)
      currentLength = combinedLength
      i++
    }

    result.push(current)
  }

  // Backward pass: fold a still-too-short trailing cue into its predecessor.
  for (let i = result.length - 1; i > 0; i--) {
    const current = result[i]
    const previous = result[i - 1]
    if (current === undefined || previous === undefined) continue
    const currentLength = getTextLength(current.text, isCjk)
    if (currentLength >= min) continue
    const combinedLength = getTextLength(previous.text, isCjk) + currentLength
    if (combinedLength > max || shouldKeepBoundary(previous, current)) continue
    result[i - 1] = mergeCuePair(previous, current, separator)
    result.splice(i, 1)
  }

  return result
}

export function optimizeCues(cues: SubtitleCue[], language: string, semantic = true): SubtitleCue[] {
  if (cues.length === 0) return []
  let result = processCues(cues, language, false, semantic)
  // Too many wall-of-text lines -> redo with aggressive pause-word splitting.
  if (isQualityPoor(result)) result = processCues(cues, language, true, semantic)
  return rebalanceToTargetRange(result, language)
}
