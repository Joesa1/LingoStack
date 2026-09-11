/**
 * Concurrency-limited queue with priority for interactive selection requests.
 *
 * Pure — no chrome API dependency. Used to cap `translate` RPCs in flight
 * (README §7.5: `MAX_INFLIGHT ~3`). Waiting tasks remain FIFO within each priority. Running tasks are never interrupted.
 */
export class QueueCancelledError extends Error {
  constructor() {
    super("Queued task was cancelled.")
    this.name = "QueueCancelledError"
  }
}

type WaitingEntry = {
  priority: boolean
  start: () => void
  cancel: () => void
}

export class RateLimitedQueue {
  private running = 0
  private readonly waiting: WaitingEntry[] = []

  constructor(private readonly maxInflight: number) {}

  get inflightCount(): number {
    return this.running
  }

  async enqueue<T>(task: () => Promise<T>, signal?: AbortSignal, priority = false): Promise<T> {
    await this.acquire(signal, priority)
    try {
      if (signal?.aborted === true) throw new QueueCancelledError()
      return await task()
    } finally {
      this.release()
    }
  }

  private acquire(signal: AbortSignal | undefined, priority: boolean): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(new QueueCancelledError())
    if (this.running < this.maxInflight) {
      this.running += 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const entry: WaitingEntry = {
        priority,
        start: () => {
          signal?.removeEventListener("abort", entry.cancel)
          this.running += 1
          resolve()
        },
        cancel: () => {
          const index = this.waiting.indexOf(entry)
          if (index !== -1) this.waiting.splice(index, 1)
          reject(new QueueCancelledError())
        },
      }
      signal?.addEventListener("abort", entry.cancel, { once: true })
      const index = priority ? this.waiting.findIndex(item => !item.priority) : -1
      if (index < 0) this.waiting.push(entry)
      else this.waiting.splice(index, 0, entry)
    })
  }

  private release(): void {
    this.running -= 1
    const next = this.waiting.shift()
    next?.start()
  }
}
