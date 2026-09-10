/**
 * Applies a `TR_SET_MODE` page-level mode change: turning translation on
 * walks, language-filters (D9), and hands the surviving units to the
 * viewport scheduler (D12) — units are submitted as they near the viewport,
 * not all at once. Turning it off restores everything and drops all pending
 * scheduling. Bumps the client's generation on every mode change (README
 * §7.7) — the `TrSetModeMessage.generation` field is not read here:
 * generation is content-owned state (per-tab, tracked in `TranslateClient`),
 * so the authoritative bump happens locally on receipt, not from a value
 * background assigns (background cannot know this tab's current generation
 * counter).
 *
 * The walk itself is sync (under a paused observer — it mutates the page via
 * segment wrapping), but the language filter is async and viewport
 * callbacks fire arbitrarily later: both re-check the generation before
 * submitting, so a toggle-off (or mode/lang switch) cleanly aborts stale
 * work.
 *
 * Based on: docs/packages/web-translate/README.md §7.6, §7.7, D9, D12
 */
import type { TrPageMode, TrSetModeMessage } from "../shared/types"

import { restoreAll } from "./backfill"
import type { LanguageFilter } from "./language-filter"
import type { MutationWatcher } from "./mutation-watcher"
import type { ResolvedSiteRules } from "./site-rules"
import type { TranslateClient } from "./translate-client"
import type { ViewportScheduler } from "./viewport-scheduler"
import type { DomWalker } from "./walker"

export type PageModeClientDeps = {
  walker: DomWalker
  client: TranslateClient
  watcher: MutationWatcher
  languageFilter: LanguageFilter
  scheduler: ViewportScheduler
  root: Document
  /** Resolved once from `location.hostname` at content-script init (§7.1a) — none of the built-in rules are path-scoped, so a static value is correct for this client's whole lifetime. */
  siteRules: ResolvedSiteRules
}

export type PageModeClient = {
  applyMode(mode: TrPageMode, targetLang: string, skipCache?: boolean): void
  getMode(): TrPageMode
  getTargetLang(): string
}

/** `document.title` for a page/frame with no `<title>` is `""`, not `undefined` — normalize so "omitted" and "empty" don't become distinct cache/batch-key values (contract: `TranslateContext.pageTitle` is omitted when unavailable). */
export function readPageTitle(root: Document): string | undefined {
  const title = root.title.trim()
  return title.length === 0 ? undefined : title
}

export function createPageModeClient(deps: PageModeClientDeps): PageModeClient {
  let mode: TrPageMode = "off"
  let targetLang = "en"

  return {
    applyMode(newMode, newTargetLang, skipCache) {
      mode = newMode
      targetLang = newTargetLang
      const generation = deps.client.bumpGeneration()
      deps.scheduler.disconnect() // drop scheduling from the previous mode/lang

      if (newMode === "off") {
        deps.watcher.disconnect()
        deps.watcher.withPaused(() => restoreAll(deps.root))
        return
      }
      deps.watcher.observe(deps.root)
      // Snapshot once per mode application — the viewport scheduler's callback
      // below fires repeatedly as the user scrolls, and pageTitle participates
      // in the batch-partition/cache key, so a live re-read would fragment
      // both across a single session on any page with a mutating title.
      const pageTitle = readPageTitle(deps.root)
      // The walk mutates the page (segment wrapping in mixed containers,
      // walker.ts), so it must not run under live observation.
      const units = deps.watcher.withPaused(() =>
        deps.walker.collectUnits(deps.root, { targetLang: newTargetLang, siteRules: deps.siteRules }),
      )
      void deps.languageFilter.filterUnits(units, newTargetLang).then((kept) => {
        if (deps.client.getGeneration() !== generation) return // mode changed mid-filter
        deps.scheduler.schedule(kept, (visible) => {
          if (deps.client.getGeneration() !== generation) return // mode changed while off-screen
          deps.client.submit(visible, {
            targetLang: newTargetLang,
            mode: newMode,
            skipCache,
            pageTitle,
          })
        })
      })
    },
    getMode: () => mode,
    getTargetLang: () => targetLang,
  }
}

export function isSetModeMessage(message: unknown): message is TrSetModeMessage {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "TR_SET_MODE"
}
