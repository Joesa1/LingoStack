/**
 * Viewport-first submission scheduler (D12):
 * collected units are NOT submitted all at once; each unit's element is
 * watched with an IntersectionObserver (`rootMargin: 600px`, threshold 0.1)
 * and submitted only when it scrolls near the viewport. On a long page this
 * keeps the request queue working on what the user can see (visible content
 * backfills in roughly one batch round-trip) and never spends tokens on
 * content that is never scrolled to.
 *
 * The observer factory is injected: jsdom has no IntersectionObserver, and
 * an environment without one degrades to submitting everything immediately
 * (translate everything > translate nothing).
 *
 * `disconnect()` drops every pending unit and stops the observer — callers
 * invoke it on mode/lang changes (the new applyMode re-walks and re-schedules
 * under the new generation).
 *
 * Based on: docs/packages/web-translate/README.md §7.6, D12
 */
import type { TranslationUnit } from "./walker"

/** The subset of IntersectionObserver this module needs (injectable for tests). */
export type UnitObserver = {
  observe(el: Element): void
  unobserve(el: Element): void
  disconnect(): void
}

export type ObserverFactory = (onIntersect: (elements: Element[]) => void) => UnitObserver | undefined

export type ViewportScheduler = {
  /** Watch units and call `onVisible` (possibly repeatedly, in visibility order) as they near the viewport. */
  schedule(units: TranslationUnit[], onVisible: (units: TranslationUnit[]) => void): void
  /** Stop watching and drop all pending units. */
  disconnect(): void
}

export const VIEWPORT_ROOT_MARGIN = "600px"
export const VIEWPORT_THRESHOLD = 0.1

type PendingEntry = { unit: TranslationUnit; onVisible: (units: TranslationUnit[]) => void }

export function createViewportScheduler(deps: { createObserver: ObserverFactory }): ViewportScheduler {
  let observer: UnitObserver | undefined
  const pendingByElement = new Map<Element, PendingEntry>()

  function handleIntersect(elements: Element[]): void {
    // Group per callback so one submit covers all units that surfaced together.
    const byCallback = new Map<(units: TranslationUnit[]) => void, TranslationUnit[]>()
    for (const el of elements) {
      const entry = pendingByElement.get(el)
      if (entry === undefined) continue
      pendingByElement.delete(el)
      observer?.unobserve(el)
      const group = byCallback.get(entry.onVisible)
      if (group === undefined) byCallback.set(entry.onVisible, [entry.unit])
      else group.push(entry.unit)
    }
    for (const [onVisible, units] of byCallback) onVisible(units)
  }

  return {
    schedule(units, onVisible) {
      if (units.length === 0) return
      observer ??= deps.createObserver(handleIntersect)
      if (observer === undefined) {
        onVisible(units) // no IntersectionObserver in this environment — degrade to immediate submission
        return
      }
      for (const unit of units) {
        pendingByElement.set(unit.element, { unit, onVisible })
        observer.observe(unit.element)
      }
    },
    disconnect() {
      observer?.disconnect()
      observer = undefined
      pendingByElement.clear()
    },
  }
}

/** Real-runtime factory. `undefined` (no IntersectionObserver) makes the scheduler degrade to immediate submission. */
export function domObserverFactory(onIntersect: (elements: Element[]) => void): UnitObserver | undefined {
  if (typeof IntersectionObserver === "undefined") return undefined
  return new IntersectionObserver(
    (entries, observer) => {
      const visible: Element[] = []
      for (const entry of entries) {
        if (entry.isIntersecting) visible.push(entry.target)
      }
      if (visible.length > 0) onIntersect(visible)
      void observer
    },
    { root: null, rootMargin: VIEWPORT_ROOT_MARGIN, threshold: VIEWPORT_THRESHOLD },
  )
}
