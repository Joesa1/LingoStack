/**
 * Translation cache (background service worker).
 *
 * `CacheStore` is injected so the cache logic is unit-testable without a real
 * IndexedDB (jsdom does not implement it — verified directly). Production
 * uses `createIndexedDbCacheStore`; tests use `createInMemoryCacheStore`.
 *
 * `computeCacheKey` folds sourceLang into the key (explicit vs auto can
 * change output, so a mismatch must never share a cache hit). `mode` is NOT
 * in the key (D11): since prompt version "2" the translation prompt is
 * mode-independent (bilingual vs only differ only in extension-side
 * rendering), so both modes share one cache entry —
 * switching modes re-renders from cache instead of re-paying tokens.
 * `pageTitle` participates in the key (prompt version "3"): different host
 * pages can share text but need distinct cache entries when the system prompt
 * includes title metadata.
 * `cacheScope` participates in the key (security boundary, not perf): a batch
 * result can be influenced by other units batched with it (a page's own text
 * prompt-injecting its own batch), so a translation is only shared with — and
 * an in-flight promise only joined by — submitters in the SAME trust domain.
 * The background resolves it to the submitting frame's origin (same-origin
 * pages/tabs still share, the legitimate case), falling back to a
 * per-document scope when the origin is unavailable (no sharing). This closes
 * cross-origin cache/in-flight poisoning that document-granular batch
 * partitioning alone cannot (partitioning only unmixes wire batches; the
 * dedup layers sit in front of it).
 * `cacheNamespace` is an opaque extension-provided fingerprint of the active
 * provider/model selection. It changes on model switch, so old cache entries
 * and in-flight promises become unreachable without exposing provider ids.
 *
 * V1 has no LRU eviction (README §7.5, deferred by design — unlimitedStorage
 * carries it for now).
 *
 * Based on: docs/packages/web-translate/README.md §7.5, D11
 */
import { normalizeText } from "../shared/text-normalize"
import type { SelectionTranslateOptions, SelectionTranslationDetails } from "../shared/types"

export type CacheEntry = {
  sourceText: string
  targetText: string
  targetLang: string
  sourceLang?: string
  details?: SelectionTranslationDetails
  promptVersion: string
  createdAt: number
  hitAt: number
}

export type CacheKeyInput = {
  text: string
  targetLang: string
  sourceLang?: string
  pageTitle?: string
  selection?: SelectionTranslateOptions
  promptVersion: string
  /** Trust-domain scope (submitting frame's origin, or a per-document fallback) — see the module comment. */
  cacheScope: string
  /** Opaque extension model-selection fingerprint. */
  cacheNamespace: string
}

export type CacheStore = {
  get(key: string): Promise<CacheEntry | undefined>
  put(key: string, entry: CacheEntry): Promise<void>
}

const DB_NAME = "lingo-companion"
const DB_VERSION = 1
const STORE_NAME = "translations"

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** JSON-encode the tuple (not string-concat) so no delimiter can collide with user text, then hash it. */
export async function computeCacheKey(input: CacheKeyInput): Promise<string> {
  const tuple = [
    normalizeText(input.text),
    input.targetLang,
    input.sourceLang ?? null,
    input.pageTitle ?? null,
    input.selection ?? null,
    input.promptVersion,
    input.cacheScope,
    input.cacheNamespace,
  ]
  return sha256Hex(JSON.stringify(tuple))
}

/**
 * Test fixture. Production always uses `createIndexedDbCacheStore` — there is
 * no runtime swap to this store; graceful degradation on an IndexedDB failure
 * happens one layer up (translate-batcher.ts catches `get`/`put` rejections
 * and treats them as a cache miss/no-op instead of switching backing stores).
 */
export function createInMemoryCacheStore(): CacheStore {
  const map = new Map<string, CacheEntry>()
  return {
    async get(key) {
      return map.get(key)
    },
    async put(key, entry) {
      map.set(key, entry)
    },
  }
}

/** Real IndexedDB-backed store. Not unit-tested directly (jsdom has no IndexedDB); exercised manually/E2E. */
export function createIndexedDbCacheStore(): CacheStore {
  let dbPromise: Promise<IDBDatabase> | undefined

  function openDb(): Promise<IDBDatabase> {
    if (dbPromise !== undefined) return dbPromise
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error("Failed to open the translation cache database."))
    })
    return dbPromise
  }

  return {
    async get(key) {
      const db = await openDb()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly")
        const req = tx.objectStore(STORE_NAME).get(key)
        req.onsuccess = () => resolve(req.result as CacheEntry | undefined)
        req.onerror = () => reject(req.error ?? new Error("Failed to read a translation cache entry."))
      })
    },
    async put(key, entry) {
      const db = await openDb()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite")
        tx.objectStore(STORE_NAME).put(entry, key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error("Failed to write a translation cache entry."))
      })
    },
  }
}
