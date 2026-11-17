import { CheckError } from './types.ts'

/**
 * 同時実行数 max の待ち行列。待ちが timeoutMs を超えたら CheckError('busy')。
 * fn が投げた場合・待ち中に signal が abort された場合もスロットを解放する。
 * fn が signal を無視して返らなければ、そのスロットは fn が返るまで保持される。
 */
export function createGate(max: number, timeoutMs: number) {
  let active = 0
  const waiters: { wake: () => void }[] = []

  const release = (): void => {
    const next = waiters.shift()
    // 空きは待ちへ直接渡す（active は変えない）
    if (next) next.wake()
    else active--
  }

  const acquire = (signal?: AbortSignal): Promise<void> => {
    if (active < max) {
      active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        remove()
        reject(signal!.reason)
      }
      const remove = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const i = waiters.indexOf(w)
        if (i >= 0) waiters.splice(i, 1)
      }
      const timer = setTimeout(() => {
        remove()
        reject(new CheckError('busy', '混雑しています。しばらくしてから再試行してください'))
      }, timeoutMs)
      const w = {
        wake: () => {
          remove()
          resolve()
        },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      waiters.push(w)
    })
  }

  return {
    async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) throw signal.reason
      await acquire(signal)
      try {
        return await fn()
      } finally {
        release()
      }
    },
  }
}
