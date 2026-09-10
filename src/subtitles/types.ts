/**
 * Subtitle pipeline data shapes (content-script-internal — cues hold no DOM
 * refs but never cross the extension/extension wire as-is; the wire carries
 * plain `TranslateItem`s).
 *
 * Based on: docs/packages/web-translate/README.md §7.9 (D17).
 */

/** One subtitle cue. `start`/`end` are milliseconds on the video timeline. */
export type SubtitleCue = {
  text: string
  start: number
  end: number
  /** Filled in progressively by the coordinator. Absent = not translated yet. */
  translation?: string
}

/** Overlay status pill state. `idle` renders nothing. */
export type SubtitleOverlayState = "idle" | "loading" | "error"
