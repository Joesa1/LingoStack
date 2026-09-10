import { describe, it, expect, vi } from "vitest"

import type { SubtitleCue } from "./types"

import { TRANSLATE_LOOK_AHEAD_MS, createSubtitleCoordinator } from "./coordinator"

function makeVideo(currentTimeSeconds = 0): HTMLVideoElement {
  const video = document.createElement("video")
  Object.defineProperty(video, "currentTime", { value: currentTimeSeconds, writable: true })
  return video
}

function tick(video: HTMLVideoElement, seconds?: number): void {
  if (seconds !== undefined) (video as unknown as { currentTime: number }).currentTime = seconds
  video.dispatchEvent(new Event("timeupdate"))
}

function cue(start: number, text = `t${start}`): SubtitleCue {
  return { text, start, end: start + 1000 }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe("createSubtitleCoordinator", () => {
  it("translates only cues inside [now-5s, now+30s], capped at 5 per batch", async () => {
    const video = makeVideo(10) // 10_000ms
    const cues = [
      cue(1_000), // behind the look-behind window
      cue(6_000),
      cue(12_000),
      cue(15_000),
      cue(20_000),
      cue(25_000),
      cue(30_000),
      cue(10_000 + TRANSLATE_LOOK_AHEAD_MS + 1), // beyond look-ahead
    ]
    const translateBatch = vi.fn(async (batch: SubtitleCue[]) =>
      batch.map((c) => ({ start: c.start, translation: `T:${c.text}` })),
    )
    const coordinator = createSubtitleCoordinator({
      video,
      getCues: () => cues,
      translateBatch,
      onTranslated: vi.fn(),
      onStateChange: vi.fn(),
    })
    coordinator.start()
    await flushMicrotasks()

    expect(translateBatch).toHaveBeenCalledTimes(1)
    const firstBatch = translateBatch.mock.calls[0]?.[0] ?? []
    expect(firstBatch.map((c) => c.start)).toEqual([6_000, 12_000, 15_000, 20_000, 25_000])
    coordinator.stop()
  })

  it("keeps a single batch in flight and continues with the rest on the next tick", async () => {
    const video = makeVideo(0)
    const cues = Array.from({ length: 7 }, (_, i) => cue(i * 1000))
    let resolveFirst: ((r: { start: number; translation: string }[]) => void) | undefined
    const translateBatch = vi
      .fn<(batch: SubtitleCue[]) => Promise<{ start: number; translation: string | undefined }[]>>()
      .mockImplementationOnce(
        (batch) =>
          new Promise((resolve) => {
            resolveFirst = (r) => resolve(r)
            void batch
          }),
      )
      .mockImplementation(async (batch) => batch.map((c) => ({ start: c.start, translation: "x" })))

    const onTranslated = vi.fn()
    const coordinator = createSubtitleCoordinator({
      video,
      getCues: () => cues,
      translateBatch,
      onTranslated,
      onStateChange: vi.fn(),
    })
    coordinator.start()
    await flushMicrotasks()

    tick(video) // first batch still pending — no second submit
    expect(translateBatch).toHaveBeenCalledTimes(1)

    resolveFirst?.((translateBatch.mock.calls[0]?.[0] ?? []).map((c: SubtitleCue) => ({ start: c.start, translation: "x" })))
    await flushMicrotasks()
    tick(video)
    await flushMicrotasks()
    expect(translateBatch).toHaveBeenCalledTimes(2)
    const secondBatch = translateBatch.mock.calls[1]?.[0] ?? []
    expect(secondBatch.map((c: SubtitleCue) => c.start)).toEqual([5_000, 6_000])
    coordinator.stop()
  })

  it("per-cue failure marks the cue failed and never resubmits it", async () => {
    const video = makeVideo(0)
    const cues = [cue(0)]
    const translateBatch = vi.fn(async (batch: SubtitleCue[]) =>
      batch.map((c) => ({ start: c.start, translation: undefined })),
    )
    const onTranslated = vi.fn()
    const coordinator = createSubtitleCoordinator({
      video,
      getCues: () => cues,
      translateBatch,
      onTranslated,
      onStateChange: vi.fn(),
    })
    coordinator.start()
    await flushMicrotasks()
    tick(video)
    await flushMicrotasks()

    expect(translateBatch).toHaveBeenCalledTimes(1)
    expect(onTranslated).not.toHaveBeenCalled()
    coordinator.stop()
  })

  it("whole-batch rejection emits an error state and keeps playing", async () => {
    const video = makeVideo(0)
    const cues = [cue(0)]
    const translateBatch = vi.fn(async () => {
      throw new Error("port dropped")
    })
    const onStateChange = vi.fn()
    const coordinator = createSubtitleCoordinator({
      video,
      getCues: () => cues,
      translateBatch,
      onTranslated: vi.fn(),
      onStateChange,
    })
    coordinator.start()
    await flushMicrotasks()
    expect(onStateChange).toHaveBeenCalledWith("error", "port dropped")
    coordinator.stop()
  })

  it("reports loading while the active cue is unresolved, idle once translated", async () => {
    const video = makeVideo(0.5) // inside cue(0)
    const cues = [cue(0)]
    const onStateChange = vi.fn()
    const translateBatch = vi.fn(async (batch: SubtitleCue[]) =>
      batch.map((c) => ({ start: c.start, translation: "done" })),
    )
    const coordinator = createSubtitleCoordinator({
      video,
      getCues: () => cues,
      translateBatch,
      onTranslated: vi.fn(),
      onStateChange,
    })
    coordinator.start()
    expect(onStateChange).toHaveBeenCalledWith("loading", undefined)
    await flushMicrotasks()
    expect(onStateChange).toHaveBeenLastCalledWith("idle", undefined)
    coordinator.stop()
  })

  it("stop() detaches the tick listeners", async () => {
    const video = makeVideo(0)
    const translateBatch = vi.fn(async () => [])
    const coordinator = createSubtitleCoordinator({
      video,
      getCues: () => [cue(0)],
      translateBatch,
      onTranslated: vi.fn(),
      onStateChange: vi.fn(),
    })
    coordinator.start()
    await flushMicrotasks()
    coordinator.stop()
    translateBatch.mockClear()
    tick(video)
    await flushMicrotasks()
    expect(translateBatch).not.toHaveBeenCalled()
  })
})
