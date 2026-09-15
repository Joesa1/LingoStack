import type { TranslateMode } from "./types"

export const LANGUAGES: Record<string, string> = { "zh-CN": "简体中文", "zh-TW": "繁體中文", en: "English", ja: "日本語", ko: "한국어", fr: "Français", de: "Deutsch", es: "Español", ru: "Русский", ar: "العربية", pt: "Português", it: "Italiano" }
export type WebTranslateSettings = {
  translationColorMode: "auto" | "custom"; translationColor: string;
  mode: TranslateMode; targetLang: string; selectionEnabled: boolean; subtitlesEnabled: boolean
  ttsRevision: string; voiceName: string; speechRate: number; muteOriginal: boolean; waitForSpeech: boolean; speechMode: "natural" | "sync"
}
export const DEFAULT_SETTINGS: WebTranslateSettings = { translationColorMode: "auto", translationColor: "#007aff", mode: "bilingual", targetLang: "zh-CN", selectionEnabled: true, subtitlesEnabled: false, ttsRevision: "", voiceName: "", speechRate: 1, muteOriginal: true, waitForSpeech: true, speechMode: "natural" }
export const SETTINGS_KEY = "lingoSettings"
export type StorageArea = { get(keys: string | string[]): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> }
export type StorageChanges = Record<string, { newValue?: unknown }>

export function parseSettings(raw: unknown): WebTranslateSettings {
  const r = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  return {
    translationColorMode: r.translationColorMode === "custom" ? "custom" : "auto",
    translationColor: typeof r.translationColor === "string" && /^#[0-9a-f]{6}$/i.test(r.translationColor) ? r.translationColor : "#007aff",
    mode: r.mode === "only" ? "only" : "bilingual",
    targetLang: typeof r.targetLang === "string" && r.targetLang in LANGUAGES ? r.targetLang : "zh-CN",
    selectionEnabled: typeof r.selectionEnabled === "boolean" ? r.selectionEnabled : true,
    subtitlesEnabled: false,
    ttsRevision: typeof r.ttsRevision === "string" ? r.ttsRevision.slice(0, 100) : "",
    voiceName: typeof r.voiceName === "string" ? r.voiceName.slice(0, 200) : "",
    speechRate: typeof r.speechRate === "number" && Number.isFinite(r.speechRate) ? Math.min(2, Math.max(0.5, r.speechRate)) : 1,
    muteOriginal: typeof r.muteOriginal === "boolean" ? r.muteOriginal : true,
    waitForSpeech: typeof r.waitForSpeech === "boolean" ? r.waitForSpeech : true,
    speechMode: r.speechMode === "sync" ? "sync" : "natural",
  }
}
export async function readSettings(storage: StorageArea): Promise<WebTranslateSettings> { return parseSettings((await storage.get(SETTINGS_KEY))[SETTINGS_KEY]) }
export async function writeSettings(storage: StorageArea, patch: Partial<WebTranslateSettings>): Promise<WebTranslateSettings> {
  const next = parseSettings({ ...await readSettings(storage), ...patch })
  await storage.set({ [SETTINGS_KEY]: next })
  return next
}
export function readChangedSettings(changes: StorageChanges, area: string): WebTranslateSettings | undefined {
  return area === "session" && changes[SETTINGS_KEY] ? parseSettings(changes[SETTINGS_KEY].newValue) : undefined
}
