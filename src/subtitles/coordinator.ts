/**
 * Playback-driven translation scheduling: on every `timeupdate`/`seeked`
 * tick, submit the untranslated cues inside the window
 * [now - 5s, now + 30s], at most 5 per batch, one batch in flight at a time.
 * Translated cues flow back through
 * `onTranslated`; failed cues are marked and not auto-retried here — the
 * background batcher already ran its own retry policy (D14) underneath.
 *
 * The status callback drives the overlay pill: `loading` while the active
 * (or upcoming) cue is still unresolved, `idle` otherwise.
 *
 * Based on: docs/packages/web-translate/README.md §7.9 (D17).
 */
import type { SubtitleCue, SubtitleOverlayState } from "./types"

export const TRANSLATION_BATCH_SIZE = 5
export const TRANSLATE_LOOK_AHEAD_MS = 30_000
export const TRANSLATE_LOOK_BEHIND_MS = 5_000

export type SubtitleCoordinatorDeps = {
  video: HTMLVideoElement
  getCues: () => readonly SubtitleCue[]
  /** Translate cue texts; one result per input, `translation: undefined` = failed. Rejects = whole batch failed. */
  translateBatch: (cues: SubtitleCue[]) => Promise<{ start: number; translation: string | undefined }[]>
  onTranslated: (cues: SubtitleCue[]) => void
  onStateChange: (state: SubtitleOverlayState, message?: string) => void
}

export type SubtitleCoordinator = {
  start(): void
  stop(): void
}

export function createSubtitleCoordinator(deps: SubtitleCoordinatorDeps): SubtitleCoordinator {
  const translatingStarts = new Set<number>()
  const translatedStarts = new Set<number>()
  const failedStarts = new Set<number>()
  let isTranslating = false
  let running = false
  let lastEmittedState: SubtitleOverlayState = "idle"

  function isCueResolved(start: number): boolean {
    return translatedStarts.has(start) || failedStarts.has(start)
  }

  function emitState(state: SubtitleOverlayState, message?: string): void {
    if (state === lastEmittedState) return
    lastEmittedState = state
    deps.onStateChange(state, message)
  }

  function updateLoadingState(timeMs: number, cues: readonly SubtitleCue[]): void {
    const active = cues.find((c) => c.start <= timeMs && c.end > timeMs)
    if (active !== undefined) {
      emitState(isCueResolved(active.start) ? "idle" : "loading")
      return
    }
    // In a gap: keep the pill honest about the upcoming cue.
    const next = cues.find((c) => c.start > timeMs)
    emitState(next !== undefined && !isCueResolved(next.start) ? "loading" : "idle")
  }

  async function translateNearby(currentTimeMs: number): Promise<void> {
    const batch = deps
      .getCues()
      .filter(
        (c) =>
          !translatedStarts.has(c.start) &&
          !translatingStarts.has(c.start) &&
          !failedStarts.has(c.start) &&
          c.start >= currentTimeMs - TRANSLATE_LOOK_BEHIND_MS &&
          c.start <= currentTimeMs + TRANSLATE_LOOK_AHEAD_MS,
      )
      .slice(0, TRANSLATION_BATCH_SIZE)

    if (batch.length === 0) return

    isTranslating = true
    for (const cue of batch) translatingStarts.add(cue.start)

    try {
      const results = await deps.translateBatch([...batch])
      if (!running) return
      const byStart = new Map(batch.map((cue) => [cue.start, cue]))
      const translated: SubtitleCue[] = []
      for (const result of results) {
        const cue = byStart.get(result.start)
        if (cue === undefined) continue
        translatingStarts.delete(result.start)
        if (result.translation !== undefined) {
          translatedStarts.add(result.start)
          translated.push({ ...cue, translation: result.translation })
        } else {
          // Per-cue failure: bilingual rendering degrades to the original line.
          failedStarts.add(result.start)
        }
      }
      if (translated.length > 0) deps.onTranslated(translated)
      if (running) updateLoadingState(deps.video.currentTime * 1000, deps.getCues())
    } catch (error) {
      // Whole batch failed (port drop / stale generation) — mark failed, keep playing.
      for (const cue of batch) {
        translatingStarts.delete(cue.start)
        failedStarts.add(cue.start)
      }
      if (running) emitState("error", error instanceof Error ? error.message : String(error))
    } finally {
      isTranslating = false
    }
  }

  const handleTick = (): void => {
    if (!running) return
    const currentTimeMs = deps.video.currentTime * 1000
    updateLoadingState(currentTimeMs, deps.getCues())
    if (isTranslating) return
    void translateNearby(currentTimeMs)
  }

  return {
    start() {
      if (running) return
      running = true
      deps.video.addEventListener("timeupdate", handleTick)
      deps.video.addEventListener("seeked", handleTick)
      handleTick()
    },
    stop() {
      if (!running) return
      running = false
      deps.video.removeEventListener("timeupdate", handleTick)
      deps.video.removeEventListener("seeked", handleTick)
    },
  }
}
