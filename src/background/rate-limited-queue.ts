/**
 * Generic FIFO queue capping concurrent async tasks at `maxInflight`.
 *
 * Pure — no chrome API dependency. Used to cap `translate` RPCs in flight
 * (README §7.5: `MAX_INFLIGHT ~3`). V1 accepts plain FIFO fairness across
 * tabs (README §7.5 known limitation): no per-tab round-robin.
 */
export class QueueCancelledError extends Error {
  constructor() {
    super("Queued task was cancelled.")
    this.name = "QueueCancelledError"
  }
}

type WaitingEntry = {
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

  async enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      if (signal?.aborted === true) throw new QueueCancelledError()
      return await task()
    } finally {
      this.release()
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(new QueueCancelledError())
    if (this.running < this.maxInflight) {
      this.running += 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const entry: WaitingEntry = {
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
      this.waiting.push(entry)
    })
  }

  private release(): void {
    this.running -= 1
    const next = this.waiting.shift()
    next?.start()
  }
}
