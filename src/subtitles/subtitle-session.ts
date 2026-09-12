import { watchDisplayedCaptions } from "./live-captions"
import { createSpeechReader } from "./speech-reader"
import type { WebTranslateSettings } from "../shared/settings-store"
/**
 * One subtitle-translation session = one (videoId, targetLang) run on a
 * YouTube watch page: mount overlay -> fetch captions -> heuristic sentence
 * assembly -> hide native captions -> schedule cue display -> translate
 * around the playhead. Native captions are hidden ONLY after a fetch
 * succeeds AND the optimizer produced at least one displayable cue (raw cues
 * can be non-empty but optimize down to nothing, e.g. all-`>>`-marker
 * tracks) — either failure shows the overlay's error pill while leaving
 * YouTube's own captions untouched.
 * `stop()` tears everything down and restores native captions (a no-op if
 * they were never hidden); the enclosing entrypoint starts a fresh session on
 * toggle-on / video navigation / targetLang change.
 *
 * Passthrough: when the track's language already IS the target language (see
 * `languagesMatch`, ../shared/language-match.ts), no coordinator is created —
 * the overlay shows the original line only, and nothing is sent to the
 * provider.
 *
 * Based on: docs/packages/web-translate/README.md §7.9 (D17).
 */
import type { PlayerBridge } from "./player-bridge"
import type { SubtitleTranslateClient } from "./subtitle-translate-client"
import type { SubtitleCue } from "./types"

import { createSubtitleCoordinator, type SubtitleCoordinator } from "./coordinator"
import { mountSubtitleOverlay, type SubtitleOverlay } from "./overlay"
import { optimizeCues } from "./optimizer"
import { createSubtitleScheduler, type SubtitleScheduler } from "./scheduler"
import { SubtitleFetchError, fetchYoutubeSubtitles } from "./youtube-fetcher"
import { languagesMatch } from "../shared/language-match"

export type SubtitleSessionDeps = {
  settings: WebTranslateSettings
  speechEnabled: boolean
  bridge: PlayerBridge
  client: SubtitleTranslateClient
  playerContainer: HTMLElement
  video: HTMLVideoElement
  videoId: string
  targetLang: string
  /** Video/page title for prompt context. */
  pageTitle: string | undefined
  fetchFn: typeof fetch
  sleep: (ms: number) => Promise<void>
}

export type SubtitleSession = {
  /** Fetch + mount + begin translating. Resolves once the pipeline is running (or has rendered its error pill). */
  start(): Promise<void>
  /** Tear down overlay/listeners, restore native captions, invalidate in-flight results. */
  stop(): void
}

let cueIdCounter = 0

export function createSubtitleSession(deps: SubtitleSessionDeps): SubtitleSession {
  let overlay: SubtitleOverlay | undefined
  let scheduler: SubtitleScheduler | undefined
  let coordinator: SubtitleCoordinator | undefined
  let stopped = false
  let reader: ReturnType<typeof createSpeechReader> | undefined
  let live: ReturnType<typeof watchDisplayedCaptions> | undefined

  async function translateBatch(cues: SubtitleCue[], sourceLanguage: string) {
    const idToStart = new Map<string, number>()
    const items = cues.map((cue) => {
      const id = `cue${++cueIdCounter}`
      idToStart.set(id, cue.start)
      return { id, text: cue.text }
    })
    const results = await deps.client.translate(items, {
      targetLang: deps.targetLang,
      sourceLang: sourceLanguage,
      ...(deps.pageTitle !== undefined ? { pageTitle: deps.pageTitle } : {}),
    })
    return results.flatMap((result) => {
      const start = idToStart.get(result.id)
      if (start === undefined) return []
      return [{ start, translation: "text" in result ? result.text : undefined }]
    })
  }

  return {
    async start() {
      overlay = mountSubtitleOverlay(deps.playerContainer)
      overlay.setState("loading")

      let cues: SubtitleCue[]
      let sourceLanguage: string
      try {
        const fetched = await fetchYoutubeSubtitles(
          { bridge: deps.bridge, fetchFn: deps.fetchFn, sleep: deps.sleep },
          deps.videoId,
        )
        if (stopped) return // toggled off / navigated away while fetching
        cues = optimizeCues(fetched.cues, fetched.sourceLanguage, deps.settings.speechMode === "natural")
        sourceLanguage = fetched.sourceLanguage
      } catch (error) {
        if (stopped) return
        overlay.setState("error", "完整字幕暂不可用，正在读取播放器字幕。请打开 YouTube 的 CC。")
        const liveOverlay = overlay
        if (deps.speechEnabled) reader = createSpeechReader(deps.video, { ...deps.settings, waitForSpeech: false }, message => liveOverlay.setState("error", message))
        live = watchDisplayedCaptions({
          container: deps.playerContainer, video: deps.video,
          translate: async text => {
            const result = await deps.client.translate([{ id: `live${++cueIdCounter}`, text }], { targetLang: deps.targetLang, pageTitle: deps.pageTitle })
            const first = result[0]
            if (!first || !("text" in first)) throw new Error("Subtitle translation failed")
            return first.text
          },
          onCue: cue => {
            if (stopped) return
            if (cue) { liveOverlay.hideNativeCaptions(); liveOverlay.setState("idle") }
            liveOverlay.setCue(cue); reader?.update(cue)
          },
          onError: message => liveOverlay.setState("error", message),
        })
        return
      }

      // fetchYoutubeSubtitles guarantees non-empty raw cues, but optimizeCues
      // can still collapse them all to nothing (e.g. every cue is only a
      // ">>" speaker marker, which cleanText strips to an empty string and
      // processCues then drops). Bail the same way as a fetch failure — hide
      // NOTHING — or this would recreate the exact "neither native nor
      // replacement captions" state this session is meant to prevent.
      if (cues.length === 0) {
        overlay.setState("error", "此视频没有可用字幕。")
        return
      }

      // Cues are ready: only now is it safe to hide native captions, since
      // our overlay is about to take over showing them.
      overlay.hideNativeCaptions()
      const mountedOverlay = overlay
      if (deps.speechEnabled) reader = createSpeechReader(deps.video, { ...deps.settings, waitForSpeech: deps.settings.speechMode === "sync" }, message => mountedOverlay.setState("error", message))
      scheduler = createSubtitleScheduler({
        video: deps.video,
        onCueChange: (cue) => { mountedOverlay.setCue(cue); reader?.update(cue) },
      })
      scheduler.supplement(languagesMatch(sourceLanguage, deps.targetLang) ? cues.map(c => ({ ...c, translation: c.text })) : cues)

      // Already in the target language: display-only, never hits the provider.
      if (languagesMatch(sourceLanguage, deps.targetLang)) {
        overlay.setState("idle")
        return
      }

      const mountedScheduler = scheduler
      coordinator = createSubtitleCoordinator({
        video: deps.video,
        getCues: () => mountedScheduler.getCues(),
        translateBatch: (batch) => translateBatch(batch, sourceLanguage),
        onTranslated: (translated) => mountedScheduler.supplement(translated),
        onStateChange: (state, message) => mountedOverlay.setState(state, message),
      })
      coordinator.start()
    },
    stop() {
      stopped = true
      reader?.destroy()
      live?.stop()
      coordinator?.stop()
      scheduler?.destroy()
      overlay?.destroy()
      deps.client.bumpGeneration() // in-flight results can no longer apply
      coordinator = undefined
      scheduler = undefined
      overlay = undefined
    },
  }
}
