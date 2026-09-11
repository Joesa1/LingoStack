import { expect, it } from "vitest"
import { RateLimitedQueue } from "../src/background/rate-limited-queue"

it("starts interactive lookups before waiting page jobs without interrupting active work", async () => {
  const queue = new RateLimitedQueue(1)
  const order: string[] = []
  let release = () => {}
  const active = queue.enqueue(() => new Promise<void>(resolve => { release = resolve }))
  await Promise.resolve()
  const page = queue.enqueue(async () => { order.push("page") })
  const selection = queue.enqueue(async () => { order.push("selection") }, undefined, true)
  release()
  await Promise.all([active, page, selection])
  expect(order).toEqual(["selection", "page"])
})
