/**
 * Isolated-side client for the MAIN-world player bridge: postMessage
 * request/response correlated by a random requestId, origin-checked, with a
 * timeout that resolves `undefined` (bridge absent / page too early) instead
 * of hanging — the caller decides whether that's a retry or an error state.
 *
 * Based on: docs/packages/web-translate/README.md §7.9 (D17).
 */
import type { BridgePlayerData } from "./bridge-messages"

import {
  BRIDGE_REQUEST_TIMEOUT_MS,
  ENSURE_SUBTITLES_REQUEST_TYPE,
  ENSURE_SUBTITLES_RESPONSE_TYPE,
  PLAYER_DATA_REQUEST_TYPE,
  PLAYER_DATA_RESPONSE_TYPE,
  WAIT_TIMEDTEXT_REQUEST_TYPE,
  WAIT_TIMEDTEXT_RESPONSE_TYPE,
} from "./bridge-messages"

export type PlayerBridge = {
  /** Player snapshot for `videoId`, or `undefined` when the bridge/player isn't ready or reports an error. */
  getPlayerData(videoId: string): Promise<BridgePlayerData | undefined>
  /** Signed timedtext URL captured from YouTube's own XHR, or `undefined` when none arrives in time. */
  waitTimedtextUrl(videoId: string): Promise<string | undefined>
  /** Ask the MAIN world to switch YouTube's own captions on (forces a signed timedtext request). */
  ensureSubtitlesEnabled(): Promise<void>
}

type BridgeWindow = Pick<Window, "addEventListener" | "removeEventListener" | "postMessage"> & {
  location: { origin: string }
}

function postRequest(
  win: BridgeWindow,
  responseType: string,
  message: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID()

    const finish = (value: Record<string, unknown> | undefined): void => {
      win.removeEventListener("message", handler)
      clearTimeout(timer)
      resolve(value)
    }

    const handler = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown; requestId?: unknown } | null
      if (
        event.origin !== win.location.origin ||
        data === null ||
        typeof data !== "object" ||
        data.type !== responseType ||
        data.requestId !== requestId
      ) {
        return
      }
      finish(event.data as Record<string, unknown>)
    }

    win.addEventListener("message", handler as EventListener)
    win.postMessage({ ...message, requestId }, win.location.origin)
    const timer = setTimeout(() => finish(undefined), timeoutMs)
  })
}

export function createPlayerBridge(win: BridgeWindow, timeoutMs: number = BRIDGE_REQUEST_TIMEOUT_MS): PlayerBridge {
  return {
    async getPlayerData(videoId) {
      const reply = await postRequest(
        win,
        PLAYER_DATA_RESPONSE_TYPE,
        { type: PLAYER_DATA_REQUEST_TYPE, expectedVideoId: videoId },
        timeoutMs,
      )
      if (reply === undefined || reply.success !== true) return undefined
      return reply.data as BridgePlayerData
    },
    async waitTimedtextUrl(videoId) {
      const reply = await postRequest(
        win,
        WAIT_TIMEDTEXT_RESPONSE_TYPE,
        { type: WAIT_TIMEDTEXT_REQUEST_TYPE, videoId },
        timeoutMs,
      )
      const url = reply?.url
      return typeof url === "string" ? url : undefined
    },
    async ensureSubtitlesEnabled() {
      await postRequest(win, ENSURE_SUBTITLES_RESPONSE_TYPE, { type: ENSURE_SUBTITLES_REQUEST_TYPE }, timeoutMs)
    },
  }
}
