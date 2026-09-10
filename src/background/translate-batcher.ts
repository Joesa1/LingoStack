/**
 * Cache + in-flight dedup + partitioned batching + rate limiting for
 * `translate` RPCs (README §7.5).
 *
 * Partitioning is document-granular and includes the current opaque extension
 * model cache namespace. `mode` is excluded because the prompt is render-mode
 * independent; model switches change the namespace so old batches/cache never
 * mix with new-model work.
 *
 * A single unit id per key ever gets registered for the *wire* RPC — a
 * duplicate `translate()` call for the same cache key (same normalized text
 * + context) shares the SAME `resultPromise` instead of enqueuing again;
 * `translate()` re-tags the outcome with the caller's own unit id before
 * returning it (`attachId`).
 *
 * Full-page callers also subscribe through a Port-scoped page session. Cache
 * lookup, unflushed partitions, queue waits, retry backoff, and post-RPC work
 * all stop after the last active subscriber cancels. Shared in-flight work
 * survives while another tab/frame still has an active subscriber.
 *
 * `translate()` NEVER rejects: `cache.get`/`cache.put` failures (production
 * IndexedDB unavailable/corrupt/quota-blocked) are caught and treated as a
 * cache miss/no-op rather than propagated, so a broken cache degrades to
 * "always hits the RPC" instead of leaving every unit stuck in "loading"
 * forever (the caller only attaches `.then(...)`, no `.catch`).
 *
 * Based on: docs/packages/web-translate/README.md §7.5
 */
import type {
  SelectionTranslateOptions,
  SelectionTranslationDetails,
  TranslateMode,
  TranslateParams,
  TranslateResult,
  WebTranslateRpcErrorCode,
} from "../shared/types"

import { ProviderError } from "./provider"
import { computeCacheKey, type CacheStore } from "./cache"
import { QueueCancelledError, type RateLimitedQueue } from "./rate-limited-queue"

export type PageTranslationSession = {
  /** Unique per content-script Port. Keeps consecutive generations out of the same unflushed partition. */
  key: string
  /** Aborted when that Port disconnects because of a generation change, teardown, or tab/frame close. */
  signal: AbortSignal
}

export type BatchContext = {
  targetLang: string
  sourceLang?: string
  mode: TranslateMode
  skipCache?: boolean
  pageTitle?: string
  selection?: SelectionTranslateOptions
  /**
   * Document-granular identity of the submitting frame. Participates ONLY in
   * the batch partition: no two documents ever share one wire RPC, so their
   * per-document unit ids (each frame's walker restarts at `u1`) can never
   * collide in a batch's id→text result map. It is NOT the cache/dedup scope —
   * that is `cacheScope`, deliberately coarser so same-origin pages still
   * share (see the cache.ts module comment).
   */
  senderKey: string
  /** Trust-domain scope for the cache + in-flight dedup keys (submitting frame's origin, or a per-document fallback). See cache.ts. */
  cacheScope: string
  /** Present only for full-page translation. Selection translation is independent from page lifecycle. */
  pageSession?: PageTranslationSession
}

type ResolvedBatchContext = BatchContext & { cacheNamespace: string }

export type UnitResult =
  | { id: string; text: string; details?: SelectionTranslationDetails }
  | { id: string; error: { code: WebTranslateRpcErrorCode; message: string } }

type TextOutcome =
  | { text: string; details?: SelectionTranslationDetails }
  | { error: { code: WebTranslateRpcErrorCode; message: string } }

type WorkSubscriber = {
  active: boolean
}

type InflightWork = {
  key: string
  promise: Promise<TextOutcome>
  resolve: (outcome: TextOutcome) => void
  subscribers: Set<WorkSubscriber>
  controller: AbortController
  settled: boolean
}

type PendingUnit = {
  id: string
  text: string
  key: string
  work: InflightWork
}

type Partition = {
  context: ResolvedBatchContext
  units: PendingUnit[]
  chars: number
  timer: ReturnType<typeof setTimeout> | undefined
}

export type TranslateBatcherDeps = {
  cache: CacheStore
  queue: RateLimitedQueue
  requestTranslate: (params: TranslateParams) => Promise<TranslateResult>
  promptVersion: string
  now: () => number
  batchWindowMs: number
  batchMaxUnits: number
  batchMaxChars: number
  /** Max automatic retries per batch RPC on a transient failure (D14). */
  retryMaxRetries: number
  /** Base for the exponential retry backoff (base × 2^attempt + 10% jitter). */
  retryBaseDelayMs: number
}

const RATE_LIMIT_MESSAGE_RE = /\b429\b|too many requests|rate[ -]?limit/i

/**
 * Whether a failure is worth an automatic retry (D14):
 * - timeout / disconnect / internal (unknown) → transient, retry.
 * - provider_error → retry (upstream 5xx / network blips) UNLESS the message
 *   reads as a rate limit — 429 is fatal, not retryable: hammering a
 *   rate-limited provider with backoff ≤ seconds only digs deeper.
 * - provider_not_ready (config missing) / parse_error (deterministic at
 *   temperature 0; the D13 individual fallback is the fix) → never retry.
 */
function isRetryableFailure(code: WebTranslateRpcErrorCode, message: string): boolean {
  if (code === "timeout" || code === "connection_lost" || code === "internal_error") return true
  if (code === "provider_error") return !RATE_LIMIT_MESSAGE_RE.test(message)
  return false
}

function attachId(id: string, outcome: TextOutcome): UnitResult {
  return "text" in outcome
    ? { id, text: outcome.text, ...(outcome.details !== undefined ? { details: outcome.details } : {}) }
    : { id, error: outcome.error }
}

/** Split a partition's accumulated units into RPC-sized chunks, respecting both the unit-count and char budgets. */
function chunkUnits(units: PendingUnit[], maxUnits: number, maxChars: number): PendingUnit[][] {
  const chunks: PendingUnit[][] = []
  let current: PendingUnit[] = []
  let currentChars = 0
  for (const unit of units) {
    const wouldOverflow = current.length >= maxUnits || (current.length > 0 && currentChars + unit.text.length > maxChars)
    if (wouldOverflow) {
      chunks.push(current)
      current = []
      currentChars = 0
    }
    current.push(unit)
    currentChars += unit.text.length
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function classifyTransportError(error: unknown): { code: WebTranslateRpcErrorCode; message: string } {
  if (error instanceof ProviderError) return { code: error.code, message: error.message }
  return { code: "internal_error", message: error instanceof Error ? error.message : "Translate request failed." }
}

function partitionKeyFor(context: ResolvedBatchContext): string {
  return JSON.stringify([
    context.senderKey,
    context.pageSession?.key ?? null,
    context.targetLang,
    context.sourceLang ?? null,
    context.pageTitle ?? null,
    context.selection ?? null,
    context.cacheNamespace,
  ])
}

const CANCELLED_OUTCOME: TextOutcome = {
  error: { code: "internal_error", message: "Translation page session was cancelled." },
}

function isPageSessionCancelled(context: BatchContext): boolean {
  return context.pageSession?.signal.aborted === true
}

export class TranslateBatcher {
  private readonly inflightByKey = new Map<string, InflightWork>()
  private cacheNamespace: string
  private readonly partitions = new Map<string, Partition>()

  constructor(private readonly deps: TranslateBatcherDeps) {
    // Ephemeral per-instance namespace until the first ping/config_changed
    // resolves (D19, revised after review). A FIXED constant across service-
    // worker restarts would let a translation cached before namespace sync
    // in one SW lifetime become a false cache hit in a LATER SW lifetime
    // that also hasn't synced yet — random-per-construction retires it every
    // restart instead, the same reasoning as extension's cacheEpoch.
    this.cacheNamespace = `ephemeral:${crypto.randomUUID()}`
  }

  /** Switch cache/in-flight namespace after extension reports a provider/model change. */
  setCacheNamespace(cacheNamespace: string): void {
    if (cacheNamespace.length === 0) return
    this.cacheNamespace = cacheNamespace
  }

  /** Translate one unit. Resolves once its batch (or a cache/in-flight hit) settles — never rejects. */
  async translate(unit: { id: string; text: string }, context: BatchContext): Promise<UnitResult> {
    if (isPageSessionCancelled(context)) return attachId(unit.id, CANCELLED_OUTCOME)
    const resolvedContext: ResolvedBatchContext = { ...context, cacheNamespace: this.cacheNamespace }
    const key = await computeCacheKey({
      text: unit.text,
      targetLang: context.targetLang,
      sourceLang: context.sourceLang,
      pageTitle: context.pageTitle,
      selection: context.selection,
      promptVersion: this.deps.promptVersion,
      cacheScope: context.cacheScope,
      cacheNamespace: resolvedContext.cacheNamespace,
    })
    if (isPageSessionCancelled(context)) return attachId(unit.id, CANCELLED_OUTCOME)

    // Skip cache lookup when skipCache=true (used for retranslate after model change)
    if (context.skipCache !== true) {
      // A rejected get() (IndexedDB unavailable/corrupt/quota-blocked) is
      // treated as a cache miss, not a fatal error — translate() must never
      // reject, or the caller's `.then(...)` (message-router.ts) never runs
      // and the unit stays "loading" forever.
      const cached = await this.deps.cache.get(key).catch(() => undefined)
      if (isPageSessionCancelled(context)) return attachId(unit.id, CANCELLED_OUTCOME)
      if (cached !== undefined) {
        void this.deps.cache.put(key, { ...cached, hitAt: this.deps.now() }).catch(() => {})
        return {
          id: unit.id,
          text: cached.targetText,
          ...(cached.details !== undefined ? { details: cached.details } : {}),
        }
      }
    }

    // Skip in-flight dedup when skipCache=true — a concurrent retranslate must
    // not attach to a stale promise from the previous model/batch.
    if (context.skipCache !== true) {
      const existing = this.inflightByKey.get(key)
      if (existing !== undefined) {
        return attachId(unit.id, await this.subscribe(existing, context.pageSession?.signal))
      }
    }

    const work = this.createWork(key)
    const resultPromise = this.subscribe(work, context.pageSession?.signal)
    this.inflightByKey.set(key, work)
    void work.promise.finally(() => {
      if (this.inflightByKey.get(key) === work) this.inflightByKey.delete(key)
    })
    this.enqueueIntoPartition(resolvedContext, { id: unit.id, text: unit.text, key, work })

    return attachId(unit.id, await resultPromise)
  }

  private createWork(key: string): InflightWork {
    let resolve!: (outcome: TextOutcome) => void
    const promise = new Promise<TextOutcome>((settle) => {
      resolve = settle
    })
    return {
      key,
      promise,
      resolve,
      subscribers: new Set(),
      controller: new AbortController(),
      settled: false,
    }
  }

  private subscribe(work: InflightWork, signal?: AbortSignal): Promise<TextOutcome> {
    if (signal?.aborted === true) return Promise.resolve(CANCELLED_OUTCOME)
    const subscriber: WorkSubscriber = { active: true }
    work.subscribers.add(subscriber)

    return new Promise((resolve) => {
      let settled = false
      const finish = (outcome: TextOutcome) => {
        if (settled) return
        settled = true
        subscriber.active = false
        signal?.removeEventListener("abort", onAbort)
        resolve(outcome)
      }
      const onAbort = () => {
        finish(CANCELLED_OUTCOME)
        this.cancelWorkIfInactive(work)
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      void work.promise.then(finish)
    })
  }

  private settleWork(work: InflightWork, outcome: TextOutcome): void {
    if (work.settled) return
    work.settled = true
    work.resolve(outcome)
  }

  private isWorkActive(work: InflightWork): boolean {
    return !work.settled && Array.from(work.subscribers).some((subscriber) => subscriber.active)
  }

  private activeUnits(units: PendingUnit[]): PendingUnit[] {
    return units.filter((unit) => this.isWorkActive(unit.work))
  }

  private cancelWorkIfInactive(work: InflightWork): void {
    if (work.settled || this.isWorkActive(work)) return
    work.controller.abort()
    if (this.inflightByKey.get(work.key) === work) this.inflightByKey.delete(work.key)
    this.settleWork(work, CANCELLED_OUTCOME)
    this.pruneCancelledPartitions()
  }

  private pruneCancelledPartitions(): void {
    for (const [key, partition] of this.partitions) {
      const active = this.activeUnits(partition.units)
      if (active.length === partition.units.length) continue
      if (active.length === 0) {
        if (partition.timer !== undefined) clearTimeout(partition.timer)
        this.partitions.delete(key)
        continue
      }
      partition.units = active
      partition.chars = active.reduce((total, unit) => total + unit.text.length, 0)
    }
  }

  private enqueueIntoPartition(context: ResolvedBatchContext, unit: PendingUnit): void {
    const partitionKey = partitionKeyFor(context)
    let partition = this.partitions.get(partitionKey)
    if (partition === undefined) {
      partition = { context, units: [], chars: 0, timer: undefined }
      this.partitions.set(partitionKey, partition)
    }
    partition.units.push(unit)
    partition.chars += unit.text.length

    // Selection prompts carry per-request context and have a single-item
    // extension contract. Flush immediately so two rapid lookups never merge.
    if (context.selection !== undefined) {
      this.flushPartition(partitionKey)
      return
    }

    if (partition.units.length >= this.deps.batchMaxUnits || partition.chars >= this.deps.batchMaxChars) {
      this.flushPartition(partitionKey)
      return
    }
    partition.timer ??= setTimeout(() => this.flushPartition(partitionKey), this.deps.batchWindowMs)
  }

  private flushPartition(partitionKey: string): void {
    const partition = this.partitions.get(partitionKey)
    if (partition === undefined) return
    this.partitions.delete(partitionKey)
    if (partition.timer !== undefined) clearTimeout(partition.timer)

    const active = this.activeUnits(partition.units)
    for (const chunk of chunkUnits(active, this.deps.batchMaxUnits, this.deps.batchMaxChars)) {
      void this.sendBatch(chunk, partition.context)
    }
  }

  private createBatchCancellation(units: PendingUnit[]): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController()
    const works = Array.from(new Set(units.map((unit) => unit.work)))
    const check = () => {
      if (this.activeUnits(units).length === 0) controller.abort()
    }
    for (const work of works) work.controller.signal.addEventListener("abort", check)
    check()
    return {
      signal: controller.signal,
      dispose: () => {
        for (const work of works) work.controller.signal.removeEventListener("abort", check)
      },
    }
  }

  private retryDelay(attempt: number, units: PendingUnit[]): Promise<boolean> {
    const base = this.deps.retryBaseDelayMs * 2 ** attempt
    const withJitter = base + Math.random() * 0.1 * base
    const cancellation = this.createBatchCancellation(units)
    if (cancellation.signal.aborted) {
      cancellation.dispose()
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(true), withJitter)
      const finish = (completed: boolean) => {
        clearTimeout(timer)
        cancellation.signal.removeEventListener("abort", onAbort)
        cancellation.dispose()
        resolve(completed)
      }
      const onAbort = () => finish(false)
      cancellation.signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  /**
   * One batch RPC with automatic retries on transient failures (D14). Each
   * attempt is a separate `queue.enqueue` so backoff waits OUTSIDE the
   * concurrency slot. Retries when the RPC throws a retryable TransportError
   * or when the WHOLE batch came back with retryable per-item errors; a
   * partial result is already per-unit truth and never retried here.
   */
  private async requestWithRetry(
    units: PendingUnit[],
    context: ResolvedBatchContext,
  ): Promise<{ result: TranslateResult; units: PendingUnit[] } | undefined> {
    for (let attempt = 0; ; attempt++) {
      let attemptResult: { result: TranslateResult; units: PendingUnit[] }
      const cancellation = this.createBatchCancellation(units)
      try {
        attemptResult = await this.deps.queue.enqueue(async () => {
          const requestedUnits = this.activeUnits(units)
          if (requestedUnits.length === 0) throw new QueueCancelledError()
          const result = await this.deps.requestTranslate({
            items: requestedUnits.map((u) => ({ id: u.id, text: u.text })),
            targetLang: context.targetLang,
            ...(context.sourceLang !== undefined ? { sourceLang: context.sourceLang } : {}),
            ...(context.pageTitle !== undefined ? { pageTitle: context.pageTitle } : {}),
            ...(context.selection !== undefined ? { selection: context.selection } : {}),
            mode: context.mode,
          })
          return { result, units: requestedUnits }
        }, cancellation.signal)
      } catch (error) {
        if (error instanceof QueueCancelledError && this.activeUnits(units).length === 0) return undefined
        const classified = classifyTransportError(error)
        if (attempt < this.deps.retryMaxRetries && isRetryableFailure(classified.code, classified.message)) {
          if (!(await this.retryDelay(attempt, units))) return undefined
          continue
        }
        throw error
      } finally {
        cancellation.dispose()
      }

      const active = this.activeUnits(attemptResult.units)
      if (active.length === 0) return undefined
      const activeIds = new Set(active.map((unit) => unit.id))
      const result: TranslateResult = {
        results: attemptResult.result.results.filter((item) => activeIds.has(item.id)),
        ...(attemptResult.result.errors !== undefined
          ? { errors: attemptResult.result.errors.filter((item) => activeIds.has(item.id)) }
          : {}),
      }
      const errors = result.errors ?? []
      const wholeBatchRetryable =
        result.results.length === 0 &&
        errors.length > 0 &&
        errors.every((e) => isRetryableFailure(e.code, e.message))
      if (wholeBatchRetryable && attempt < this.deps.retryMaxRetries) {
        if (!(await this.retryDelay(attempt, active))) return undefined
        continue
      }
      return { result, units: active }
    }
  }

  private async sendBatch(units: PendingUnit[], context: ResolvedBatchContext): Promise<void> {
    try {
      const completed = await this.requestWithRetry(units, context)
      if (completed === undefined) return
      const { result } = completed
      const active = this.activeUnits(completed.units)
      if (active.length === 0) return
      const resultById = new Map(result.results.map((r) => [r.id, r]))
      const errorById = new Map((result.errors ?? []).map((e) => [e.id, e]))

      // Fallback-to-individual: a
      // multi-unit batch where EVERY unit came back parse_error is the
      // separator-count-mismatch failure shape — the model merged or split
      // segments. Single-unit requests take the "whole reply IS the
      // translation" path with no separator parsing at all, so re-sending
      // each unit individually genuinely fixes it (unlike a transport error,
      // which individual retries would just repeat — those still resolve as
      // errors below).
      if (active.length > 1 && result.results.length === 0 && active.every((u) => errorById.get(u.id)?.code === "parse_error")) {
        for (const unit of active) void this.sendBatch([unit], context)
        return
      }
      for (const unit of active) {
        const itemResult = resultById.get(unit.id)
        if (itemResult !== undefined) {
          void this.deps.cache
            .put(unit.key, {
              sourceText: unit.text,
              targetText: itemResult.text,
              ...(itemResult.details !== undefined ? { details: itemResult.details } : {}),
              targetLang: context.targetLang,
              ...(context.sourceLang !== undefined ? { sourceLang: context.sourceLang } : {}),
              promptVersion: this.deps.promptVersion,
              createdAt: this.deps.now(),
              hitAt: this.deps.now(),
            })
            .catch(() => {}) // a cache write failure must not block resolving the unit below
          this.settleWork(unit.work, {
            text: itemResult.text,
            ...(itemResult.details !== undefined ? { details: itemResult.details } : {}),
          })
          continue
        }
        const itemError = errorById.get(unit.id)
        this.settleWork(unit.work, {
          error:
            itemError !== undefined
              ? { code: itemError.code, message: itemError.message }
              : { code: "internal_error", message: `Missing result for id "${unit.id}".` },
        })
      }
    } catch (error) {
      const classified = classifyTransportError(error)
      for (const unit of this.activeUnits(units)) this.settleWork(unit.work, { error: classified })
    }
  }
}
