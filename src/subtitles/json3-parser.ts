/**
 * YouTube `timedtext?fmt=json3` response parsing: structural validation
 * (fail fast on unexpected shapes — no zod dependency in this package),
 * noise filtering, format detection, and the two parsers the minimal port
 * carries (standard + scrolling-asr). Karaoke / stylized-karaoke / animated
 * music-video formats deliberately fall back to the standard parser (D17
 * known limitation — degraded, not broken: every seg still becomes a cue).
 *
 * Based on: docs/packages/web-translate/README.md §7.9 (D17).
 */
import type { SubtitleCue } from "./types"

export type TimedTextSeg = {
  utf8: string
  tOffsetMs?: number
}

export type TimedTextEvent = {
  tStartMs: number
  dDurationMs?: number
  aAppend?: number
  segs?: TimedTextSeg[]
  wpWinPosId?: number
  wWinId?: number
}

/**
 * Validate the fetched JSON into `TimedTextEvent[]`. Unknown extra fields are
 * ignored; a missing `events` array or malformed entry throws — a shape drift
 * on YouTube's side must surface as an explicit fetch failure, not NaN cues.
 */
export function parseTimedTextResponse(data: unknown): TimedTextEvent[] {
  if (typeof data !== "object" || data === null || !Array.isArray((data as { events?: unknown }).events)) {
    throw new Error("timedtext response has no events array")
  }
  const events = (data as { events: unknown[] }).events
  return events.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) throw new Error(`timedtext event #${i} is not an object`)
    const event = raw as Record<string, unknown>
    if (typeof event.tStartMs !== "number") throw new Error(`timedtext event #${i} has no numeric tStartMs`)
    let segs: TimedTextSeg[] | undefined
    if (event.segs !== undefined) {
      if (!Array.isArray(event.segs)) throw new Error(`timedtext event #${i} segs is not an array`)
      segs = event.segs.map((rawSeg, j) => {
        const seg = rawSeg as Record<string, unknown> | null
        if (typeof seg !== "object" || seg === null || typeof seg.utf8 !== "string") {
          throw new Error(`timedtext event #${i} seg #${j} has no utf8 string`)
        }
        return {
          utf8: seg.utf8,
          ...(typeof seg.tOffsetMs === "number" ? { tOffsetMs: seg.tOffsetMs } : {}),
        }
      })
    }
    return {
      tStartMs: event.tStartMs,
      ...(typeof event.dDurationMs === "number" ? { dDurationMs: event.dDurationMs } : {}),
      ...(typeof event.aAppend === "number" ? { aAppend: event.aAppend } : {}),
      ...(segs !== undefined ? { segs } : {}),
      ...(typeof event.wpWinPosId === "number" ? { wpWinPosId: event.wpWinPosId } : {}),
      ...(typeof event.wWinId === "number" ? { wWinId: event.wWinId } : {}),
    }
  })
}

/** Annotation noise stripped from cue text. */
const NOISE_PATTERNS = [/\[.*?\]/g, /\(.*?\)/g, /♪.*?♪/g, /🎵.*?🎵/g, /🎶.*?🎶/g]

function filterNoiseText(text: string): string {
  let result = text
  for (const pattern of NOISE_PATTERNS) result = result.replace(pattern, "")
  return result
}

export function filterNoiseFromEvents(events: TimedTextEvent[]): TimedTextEvent[] {
  return events.map((event) => {
    if (event.segs === undefined) return event
    const segs = event.segs
      .map((seg) => ({ ...seg, utf8: filterNoiseText(seg.utf8) }))
      .filter((seg) => seg.utf8.trim().length > 0)
    return { ...event, segs }
  })
}

/**
 * ASR scrolling captions (the two-line rolling live-caption style) mark their
 * separator events with `wWinId` + `aAppend: 1`. Everything else — including
 * the karaoke/animated music-video formats this port does not carry dedicated
 * parsers for — is treated as "standard".
 */
export function isScrollingAsrFormat(events: TimedTextEvent[]): boolean {
  return events.some((event) => event.wWinId !== undefined && event.aAppend === 1)
}

const WHITESPACE_PATTERN = /\s+/g

/**
 * Standard format: each seg opens a cue; the next seg (or the event's own
 * duration for the last seg) closes it. An open cue's end is capped at the
 * next seg's start so consecutive cues never overlap.
 */
export function parseStandardSubtitles(events: TimedTextEvent[]): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  let buffer: SubtitleCue | null = null

  for (const { segs = [], tStartMs, dDurationMs = 0 } of events) {
    segs.forEach(({ utf8, tOffsetMs = 0 }, segIndex) => {
      const text = utf8.trim().replace(WHITESPACE_PATTERN, " ")
      const start = tStartMs + tOffsetMs

      if (buffer !== null) {
        if (buffer.end === 0 || buffer.end > start) buffer.end = start
        cues.push(buffer)
        buffer = null
      }

      buffer = { text, start, end: 0 }
      if (segIndex === segs.length - 1) buffer.end = tStartMs + dDurationMs
    })
  }

  if (buffer !== null) cues.push(buffer)
  return cues
}

/** Sentence-final punctuation that closes a scrolling-ASR cue. */
export const SENTENCE_END_PATTERN = /[,.。?？！!；;…؟۔\n]$/

const ESTIMATED_WORD_DURATION_MS = 200

const CJK_LANG_PREFIXES = ["zh", "ja", "ko", "th", "lo", "km", "my"]

export function isCjkLanguage(lang: string | undefined): boolean {
  if (lang === undefined) return false
  return CJK_LANG_PREFIXES.some((prefix) => lang.startsWith(prefix))
}

/** Cue length in "units": characters for CJK, whitespace-separated words otherwise. */
export function getTextLength(text: string, isCjk: boolean): number {
  if (isCjk) return text.length
  return text.split(/\s+/).filter(Boolean).length
}

export const MAX_WORDS = 15
export const MAX_CHARS_CJK = 30

export function getMaxLength(isCjk: boolean): number {
  return isCjk ? MAX_CHARS_CJK : MAX_WORDS
}

function isSpecialTag(text: string): boolean {
  return text.startsWith("[") && text.endsWith("]")
}

function pushCue(result: SubtitleCue[], cue: SubtitleCue): void {
  const last = result.at(-1)
  if (last !== undefined && last.end > cue.start) last.end = cue.start
  result.push(cue)
}

function flushPending(result: SubtitleCue[], text: string, start: number, end: number): void {
  const trimmed = text.trim()
  if (trimmed.length > 0 && !isSpecialTag(trimmed)) {
    pushCue(result, { text: trimmed, start, end })
  }
}

/**
 * Scrolling-ASR format: accumulate word segs across events into sentence-ish
 * cues; `aAppend: 1` separator events fix the real end time; split at
 * sentence-final punctuation or the length cap.
 */
export function parseScrollingAsrSubtitles(events: TimedTextEvent[], lang?: string): SubtitleCue[] {
  const result: SubtitleCue[] = []
  const isSpaceSeparated = lang?.startsWith("en") ?? false
  const isCjk = isCjkLanguage(lang)
  const maxLength = getMaxLength(isCjk)

  let currentText = ""
  let currentStart = 0
  let lastSegEnd = 0
  let isFirstSeg = true
  let pendingSplit = false

  const flushAndReset = (): void => {
    flushPending(result, currentText, currentStart, lastSegEnd)
    currentText = ""
    isFirstSeg = true
    pendingSplit = false
  }

  for (const event of events) {
    if (event.aAppend === 1) {
      if (currentText.length > 0) {
        lastSegEnd = event.tStartMs + (event.dDurationMs ?? 0)
        if (pendingSplit) flushAndReset()
      }
      continue
    }

    if (event.segs === undefined || event.segs.length === 0) continue
    if (pendingSplit && currentText.length > 0) flushAndReset()

    const segs = event.segs
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      if (seg === undefined) continue
      const text = seg.utf8
      const segStart = event.tStartMs + (seg.tOffsetMs ?? 0)

      if (pendingSplit && currentText.length > 0) flushAndReset()

      if (isFirstSeg && text.trim().length > 0) {
        currentStart = segStart
        isFirstSeg = false
      }

      if (isSpaceSeparated && currentText.length > 0 && text.length > 0 && i === 0) {
        if (!currentText.endsWith(" ") && !text.startsWith(" ")) currentText += " "
      }

      currentText += text
      lastSegEnd = segStart + ESTIMATED_WORD_DURATION_MS

      if (SENTENCE_END_PATTERN.test(text.trim()) || getTextLength(currentText, isCjk) >= maxLength) {
        pendingSplit = true
      }
    }
  }

  flushPending(result, currentText, currentStart, lastSegEnd)
  return result
}

/** Full pipeline: validated events -> noise filter -> format detection -> cues. */
export function parseEventsToCues(events: TimedTextEvent[], sourceLang: string | undefined): SubtitleCue[] {
  const filtered = filterNoiseFromEvents(events)
  return isScrollingAsrFormat(filtered)
    ? parseScrollingAsrSubtitles(filtered, sourceLang)
    : parseStandardSubtitles(filtered)
}
