/**
 * Active-cue tracking: listens to the video element's `timeupdate`/`seeking`,
 * finds the cue covering the current time (`start <= t < end`), and notifies
 * the overlay when it changes. `supplement` merges translated cues in by
 * `start` key (the cue identity on this timeline) and force-refreshes the
 * visible cue when its own translation just arrived.
 *
 * Based on: docs/packages/web-translate/README.md §7.9 (D17).
 */
import type { SubtitleCue } from "./types"

export type SubtitleSchedulerDeps = {
  video: HTMLVideoElement
  onCueChange: (cue: SubtitleCue | undefined) => void
}

export type SubtitleScheduler = {
  /** Replace-or-add cues (matched by `start`); re-renders the active cue if it changed. */
  supplement(cues: SubtitleCue[]): void
  getCues(): readonly SubtitleCue[]
  /** Current playback position in ms. */
  getCurrentTimeMs(): number
  /** Detach listeners and clear cues. The scheduler is single-use. */
  destroy(): void
}

export function createSubtitleScheduler(deps: SubtitleSchedulerDeps): SubtitleScheduler {
  let cues: SubtitleCue[] = []
  let currentIndex = -1

  function findActiveIndex(timeMs: number): number {
    return cues.findIndex((cue) => cue.start <= timeMs && cue.end > timeMs)
  }

  function update(force: boolean): void {
    const timeMs = deps.video.currentTime * 1000
    const newIndex = findActiveIndex(timeMs)
    if (newIndex === currentIndex && !force) return
    currentIndex = newIndex
    deps.onCueChange(newIndex >= 0 ? cues[newIndex] : undefined)
  }

  const handleTimeUpdate = (): void => update(false)
  const handleSeeking = (): void => update(true)

  deps.video.addEventListener("timeupdate", handleTimeUpdate)
  deps.video.addEventListener("seeking", handleSeeking)

  return {
    supplement(incoming) {
      if (incoming.length === 0) return
      const prevActiveStart = currentIndex >= 0 ? cues[currentIndex]?.start : undefined
      let activeTranslationArrived = false

      const byStart = new Map(cues.map((cue, i) => [cue.start, i]))
      for (const cue of incoming) {
        const existingIndex = byStart.get(cue.start)
        if (existingIndex === undefined) {
          cues.push(cue)
          continue
        }
        const existing = cues[existingIndex]
        if (existing === undefined) continue
        if (cue.translation !== undefined) {
          cues[existingIndex] = { ...existing, translation: cue.translation }
          if (existing.start === prevActiveStart) activeTranslationArrived = true
        }
      }

      cues.sort((a, b) => a.start - b.start)
      // Sorting may have shifted indices — recompute, then notify when the
      // active cue changed identity OR its translation just arrived.
      const newIndex = findActiveIndex(deps.video.currentTime * 1000)
      currentIndex = newIndex
      const newActiveStart = newIndex >= 0 ? cues[newIndex]?.start : undefined
      if (newActiveStart !== prevActiveStart || activeTranslationArrived) {
        deps.onCueChange(newIndex >= 0 ? cues[newIndex] : undefined)
      }
    },
    getCues() {
      return cues
    },
    getCurrentTimeMs() {
      return deps.video.currentTime * 1000
    },
    destroy() {
      deps.video.removeEventListener("timeupdate", handleTimeUpdate)
      deps.video.removeEventListener("seeking", handleSeeking)
      cues = []
      currentIndex = -1
    },
  }
}
