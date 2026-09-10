import type { SubtitleCue } from "./types"

// ponytail: displayed captions have approximate timing; prefer downloaded timestamped tracks whenever available.
export function watchDisplayedCaptions(deps: {
  container: HTMLElement; video: HTMLVideoElement
  translate: (text: string) => Promise<string>
  onCue: (cue: SubtitleCue | undefined) => void
  onError: (message: string) => void
}) {
  let text = ""
  let stableSince = 0
  let submitted = ""
  let epoch = 0
  let stopped = false
  let start = 0
  function tick() {
    if (stopped) return
    const current = [...deps.container.querySelectorAll(".ytp-caption-segment")].map(el => el.textContent ?? "").join(" ").trim()
    if (current !== text) {
      text = current; stableSince = Date.now(); submitted = ""; epoch++
      start = deps.video.currentTime * 1000
      if (!current) deps.onCue(undefined)
    }
    if (!text || text === submitted || Date.now() - stableSince < 300 || deps.video.paused) return
    submitted = text
    const expected = epoch
    const source = text
    void deps.translate(source).then(translation => {
      if (stopped || expected !== epoch || !translation) return
      deps.onCue({ start, end: Math.max(start + 4000, deps.video.currentTime * 1000 + 3000), text: source, translation })
    }).catch(() => { if (!stopped && expected === epoch) deps.onError("字幕翻译失败，请检查模型设置后重新开启字幕。") })
  }
  const timer = setInterval(tick, 150)
  return { stop() { stopped = true; epoch++; clearInterval(timer) } }
}
