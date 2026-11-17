// 判定サーバー（llama-server）の台への振り分け。
// 台が 1 つなら素通し（台は外さず、別の台への再試行もしない）。2 台以上なら、失敗した台を一定時間外して別の台で 1 回だけ再試行する。
import type { Config } from './config.ts'
import { CheckError } from './types.ts'

/** 失敗した台を外しておく時間（ms）。 */
export const OUT_MS = 15_000

export interface Pool {
  /** 空きのある台で fn を実行する。台の失敗は、2 台以上なら外して別の台で 1 回だけ再試行する。最終的な失敗は vlm。 */
  run<T>(fn: (url: string, signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>
}

interface Backend {
  url: string
  inflight: number
  outUntil: number
}

export function createPool(
  cfg: Pick<Config, 'vlmBaseUrls' | 'vlmSlotsPerBackend'>,
  now: () => number = Date.now,
): Pool {
  const backends: Backend[] = cfg.vlmBaseUrls.map((url) => ({ url, inflight: 0, outUntil: 0 }))
  // 空きを待つ要求。release のたびに全員を起こし、各自が空きを再判定する
  const waiters: (() => void)[] = []
  const wake = (): void => {
    for (const w of waiters.splice(0)) w()
  }

  const acquire = (tried: Set<string>, signal?: AbortSignal): Promise<Backend> =>
    new Promise<Backend>((resolve, reject) => {
      const finish = (act: () => void): void => {
        signal?.removeEventListener('abort', onAbort)
        const i = waiters.indexOf(attempt)
        if (i >= 0) waiters.splice(i, 1)
        act()
      }
      const onAbort = (): void => finish(() => reject(signal!.reason))
      const attempt = (): void => {
        if (signal?.aborted) return finish(() => reject(signal.reason))
        const t = now()
        const usable = backends.filter((b) => !tried.has(b.url) && b.outUntil <= t)
        if (usable.length === 0) {
          return finish(() => reject(new CheckError('vlm', '利用できる判定サーバーがありません')))
        }
        const free = usable.filter((b) => b.inflight < cfg.vlmSlotsPerBackend)
        if (free.length > 0) {
          const b = free.reduce((a, c) => (c.inflight < a.inflight ? c : a))
          b.inflight++
          return finish(() => resolve(b))
        }
        waiters.push(attempt)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      attempt()
    })

  const release = (b: Backend, failed: boolean): void => {
    b.inflight--
    if (failed && backends.length > 1) b.outUntil = now() + OUT_MS
    wake()
  }

  return {
    async run<T>(fn: (url: string, signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      const tried = new Set<string>()
      for (let round = 0; ; round++) {
        const b = await acquire(tried, signal)
        tried.add(b.url)
        try {
          const r = await fn(b.url, signal)
          release(b, false)
          return r
        } catch {
          if (signal?.aborted) {
            release(b, false)
            throw signal.reason
          }
          release(b, true)
          // 台が 1 つ、または 2 回目の失敗なら諦める（内容は出さない）
          if (backends.length < 2 || round >= 1) {
            throw new CheckError('vlm', '判定サーバーへの要求に失敗しました')
          }
        }
      }
    },
  }
}
