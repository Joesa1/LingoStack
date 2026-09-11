import type { SubtitleCue } from "./types"
import { normalizeText } from "../shared/text-normalize"

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" })
function newCaptionText(previous: string, current: string): string {
  const words = (text: string) => [...segmenter.segment(text)].filter(part => part.isWordLike)
  const left = words(previous)
  const right = words(current)
  for (let count = Math.min(left.length, right.length); count > 0; count--) {
    if (!right.slice(0, count).every((part, i) => part.segment.toLowerCase() === left[left.length - count + i]!.segment.toLowerCase())) continue
    const last = right[count - 1]!
    return current.slice(last.index + last.segment.length).replace(/^[\s.,!?;:，。！？；：…]+/u, "")
  }
  return current === previous ? "" : current
}

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
  let previousWindow = ""
  let epoch = 0
  let stopped = false
  let busy = false
  let start = 0
  function reset() {
    epoch++; busy = false; text = ""; submitted = ""; previousWindow = ""; stableSince = Date.now()
    deps.onCue(undefined)
  }
  function tick() {
    if (stopped || deps.video.seeking) return
    const current = normalizeText([...deps.container.querySelectorAll(".ytp-caption-segment")].map(el => el.textContent ?? "").join(" "))
    if (current !== text) {
      if (!text && Date.now() - stableSince > 1500) previousWindow = ""
      text = current; stableSince = Date.now(); submitted = ""
      start = deps.video.currentTime * 1000
      if (!current) deps.onCue(undefined)
    }
    if (busy || !text || text === submitted || Date.now() - stableSince < 300 || deps.video.paused) return
    submitted = text
    const source = newCaptionText(previousWindow, text)
    previousWindow = text
    if (!source) return
    const expected = epoch
    const cueStart = start
    busy = true
    void deps.translate(source).then(translation => {
      // A growing caption can still contain this request's words. Accept it
      // while visible, but never replay a result after a seek or window roll.
      if (stopped || expected !== epoch || !text.includes(source) || !translation) return
      deps.onCue({ start: cueStart, end: Math.max(cueStart + 4000, deps.video.currentTime * 1000 + 3000), text: source, translation })
    }).catch(() => {
      if (!stopped && expected === epoch) deps.onError("字幕翻译失败，请检查模型设置后重新开启字幕。")
    }).finally(() => { if (expected === epoch) busy = false })
  }
  deps.video.addEventListener("seeking", reset)
  const timer = setInterval(tick, 150)
  return { stop() { stopped = true; epoch++; clearInterval(timer); deps.video.removeEventListener("seeking", reset) } }
}
