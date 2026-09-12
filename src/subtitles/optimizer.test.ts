import { describe, expect, it } from "vitest"
import { optimizeCues } from "./optimizer"

describe("semantic subtitle grouping", () => {
  it("joins an English sentence split across timed-text display cues", () => {
    const result = optimizeCues([
      { text: "The system is designed to", start: 0, end: 1800 },
      { text: "help people understand complex ideas.", start: 1800, end: 4200 },
    ], "en")
    expect(result).toEqual([{ text: "The system is designed to help people understand complex ideas.", start: 0, end: 4200 }])
  })

  it("keeps a clear sentence boundary", () => {
    const result = optimizeCues([
      { text: "This is the first sentence.", start: 0, end: 1500 },
      { text: "This is the second sentence.", start: 1500, end: 3000 },
    ], "en")
    expect(result.map(cue => cue.text)).toEqual(["This is the first sentence.", "This is the second sentence."])
  })

  it("does not merge an actually long paragraph into one request", () => {
    const result = optimizeCues([
      { text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty", start: 0, end: 1000 },
      { text: "twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine thirty thirty-one thirty-two thirty-three thirty-four thirty-five thirty-six thirty-seven thirty-eight thirty-nine forty", start: 1000, end: 3000 },
    ], "en")
    expect(result.length).toBeGreaterThan(1)
  })
})
