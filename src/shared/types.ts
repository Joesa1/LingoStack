export type WebTranslateRpcErrorCode = "invalid_params" | "connection_lost" | "provider_not_ready" | "provider_error" | "parse_error" | "timeout" | "internal_error"

export type TranslateMode = "bilingual" | "only"

/** One atomic fragment to translate. `id` is assigned by the content script and echoed back for backfill matching. */
export type TranslateItem = {
  id: string
  text: string
}

/** A single unit that failed inside an otherwise-successful batch. */
export type TranslateItemError = {
  id: string
  code: WebTranslateRpcErrorCode
  message: string
}

export type SelectionContext = {
  /** Surrounding sentence/window. Untrusted webpage text, capped by the extension and revalidated by extension. */
  text: string
  /** UTF-16 offsets into `text`; `text.slice(selectionStart, selectionEnd)` must equal the selected item text. */
  selectionStart: number
  selectionEnd: number
}

export type SelectionTranslationDetails = {
  /** Optional because a provider may not be able to identify it reliably. */
  partOfSpeech?: string
  /** Other common target-language meanings, excluding the primary `text`. */
  alternatives?: string[]
}

export type SelectionTranslateOptions = {
  /** Request the dictionary-shaped response for a short word/phrase. */
  dictionary: boolean
  /** Omitted when no trustworthy surrounding sentence/window can be extracted. */
  context?: SelectionContext
}

export type TranslateParams = {
  items: TranslateItem[]
  /** BCP-47, e.g. "zh-CN". */
  targetLang: string
  /** Omitted = extension auto-detects. Participates in cache key + batch partition. */
  sourceLang?: string
  mode: TranslateMode
  /** Page title for prompt context. Participates in cache key + batch partition. */
  pageTitle?: string
  /** Selection-only prompt metadata. Valid only for a single item and mutually exclusive with pageTitle. */
  selection?: SelectionTranslateOptions
  // provider / model / credential are NOT in params: extension resolves them from
  // settings.webTranslate (independent translation-model selection).
}

export type TranslateResult = {
  results: { id: string; text: string; details?: SelectionTranslationDetails }[]
  /** A missing id goes here instead of dragging down the whole batch. */
  errors?: TranslateItemError[]
}

export type TrPageMode = TranslateMode | "off"

/** content -> background: enqueue a batch of units for a tab (progressive results return over the Port). */
export type TrTranslateMessage = {
  type: "TR_TRANSLATE"
  requestId: string
  /** per-tab monotonic epoch; echoed back so stale results (after a mode/lang/toggle switch) are dropped. */
  generation: number
  targetLang: string
  sourceLang?: string
  mode: TranslateMode
  units: TranslateItem[]
  /** When true, background should skip cache lookup for these units — used for retranslate. */
  skipCache?: boolean
  /** Host page title for prompt context; omitted when unavailable. */
  pageTitle?: string
}

/** background -> content: progressive per-unit results for a requestId. Multiple messages may arrive for one requestId. */
export type TrTranslatePartialMessage = {
  type: "TR_TRANSLATE_PARTIAL"
  requestId: string
  generation: number
  results?: { id: string; text: string }[]
  errors?: TranslateItemError[]
  /** true on the final message for this requestId. */
  done?: boolean
}

/**
 * content -> background: one-shot selection translation (drawn in the toolbar
 * bubble, no page DOM change). Deliberately carries NO pageTitle: the user
 * selected a phrase, not the page, so the full document.title must not ride
 * into the system prompt (privacy). The page-mode path (`TrTranslateMessage`)
 * still sends it — there the whole page is the translation target.
 */
export type TrSelectionTranslateMessage = {
  type: "TR_SELECTION_TRANSLATE"
  text: string
  targetLang: string
  mode: TranslateMode
  /** Optional for compatibility with older content scripts; current clients always send it. */
  selection?: SelectionTranslateOptions
}

/** Reply to TR_SELECTION_TRANSLATE. */
export type TrSelectionTranslateReply = {
  ok: boolean
  text?: string
  details?: SelectionTranslationDetails
  error?: TranslateItemError
}

/** content -> background: read current settings + readiness. */
export type TrGetSettingsMessage = {
  type: "TR_GET_SETTINGS"
}

/**
 * Reply to TR_GET_SETTINGS: translate PREFERENCES plus extension readiness.
 * There is deliberately no `enabled` field (D8): full-page translate is a
 * per-tab manual action, so "is translation on" is per-tab state owned by the
 * content script (queried via TR_GET_PAGE_STATE), not a global setting.
 */
export type TrSettingsReply = {
  mode: TranslateMode
  targetLang: string
  /** Whether the selection-translate toolbar is enabled (extension-local preference). */
  selectionEnabled: boolean
  /** Whether YouTube subtitle translation is enabled (extension-local preference, D17). */
  subtitlesEnabled: boolean
  providerReady: boolean
  /** extension's selected translate model, display names (D15) — absent when extension is unreachable or unconfigured. */
  model?: { provider?: string; model?: string }
}

/** background -> content: switch page mode (drives full-page translate / restoreAll). Sent to ONE tab (all its frames) — never broadcast globally (D8). */
export type TrSetModeMessage = {
  type: "TR_SET_MODE"
  mode: TrPageMode
  targetLang?: string
  generation: number
  /** When true, content should submit units with skipCache=true — used for retranslate to force fresh translations (e.g., after changing the model). */
  skipCache?: boolean
}

/** background -> content: ask the tab's top frame for its current translate state (D8 — content owns per-tab mode). */
export type TrGetPageStateMessage = {
  type: "TR_GET_PAGE_STATE"
}

/** Reply to TR_GET_PAGE_STATE. `mode` is "off" when the page is not translated. */
export type TrPageStateReply = {
  mode: TrPageMode
}

/** content script -> background messages. */
export type TrContentToBackgroundMessage =
  | TrTranslateMessage
  | TrSelectionTranslateMessage
  | TrGetSettingsMessage

/** background -> content script messages. */
export type TrBackgroundToContentMessage =
  | TrTranslatePartialMessage
  | TrSetModeMessage
  | TrGetPageStateMessage

export type TrMessage = TrContentToBackgroundMessage | TrBackgroundToContentMessage
