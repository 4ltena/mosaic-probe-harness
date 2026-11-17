import { describe, expect, it } from 'vitest'
import { defaultConfig, loadConfig } from '../src/config.ts'
import { createPool, OUT_MS } from '../src/pool.ts'
import { CheckError } from '../src/types.ts'

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** テスト用の時計（ms）。進めると外れた台の期限が過ぎる。 */
function clock() {
  let t = 1_000
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

const cfgOf = (urls: string[], slots = 1) => defaultConfig({ vlmBaseUrls: urls, vlmSlotsPerBackend: slots })

describe('pool: 1 台', () => {
  it('失敗しても台は外れず、直後の次の要求も同じ台に振られる', async () => {
    const pool = createPool(cfgOf(['http://a']), clock().now)
    const seen: string[] = []
    const failing = pool.run(async (url) => {
      seen.push(url)
      throw new Error('boom')
    })
    await expect(failing).rejects.toBeInstanceOf(CheckError)
    const url = await pool.run(async (u) => u)
    expect(url).toBe('http://a')
    expect(seen).toEqual(['http://a'])
  })

  it('別の台への再試行は起きない（失敗は 1 回だけ呼ばれる）', async () => {
    const pool = createPool(cfgOf(['http://a']), clock().now)
    let calls = 0
    await pool.run(async () => {
      calls++
      throw new Error('boom')
    }).catch(() => undefined)
    expect(calls).toBe(1)
  })

  it('スロット数を超えて同時に走らない', async () => {
    const pool = createPool(cfgOf(['http://a'], 1), clock().now)
    let active = 0
    let peak = 0
    await Promise.all(
      [1, 2, 3].map(() =>
        pool.run(async () => {
          active++
          peak = Math.max(peak, active)
          await tick(5)
          active--
        }),
      ),
    )
    expect(peak).toBe(1)
  })

  it('スロットが 2 なら同時に 2 件まで走る', async () => {
    const pool = createPool(cfgOf(['http://a'], 2), clock().now)
    let active = 0
    let peak = 0
    await Promise.all(
      [1, 2, 3, 4].map(() =>
        pool.run(async () => {
          active++
          peak = Math.max(peak, active)
          await tick(5)
          active--
        }),
      ),
    )
    expect(peak).toBe(2)
  })
})

describe('pool: 2 台', () => {
  it('負荷が片寄らない（同時 4 件を 2 台で 2 件ずつ）', async () => {
    const pool = createPool(cfgOf(['http://a', 'http://b'], 2), clock().now)
    const counts: Record<string, number> = {}
    await Promise.all(
      [1, 2, 3, 4].map(() =>
        pool.run(async (url) => {
          counts[url] = (counts[url] ?? 0) + 1
          await tick(5)
        }),
      ),
    )
    expect(counts).toEqual({ 'http://a': 2, 'http://b': 2 })
  })

  it('1 台が失敗したら、もう 1 台で成功する。外れた台は期限内は使われない', async () => {
    const c = clock()
    const pool = createPool(cfgOf(['http://a', 'http://b']), c.now)
    const ok = await pool.run(async (url) => {
      if (url === 'http://a') throw new Error('500')
      return url
    })
    expect(ok).toBe('http://b')
    const used: string[] = []
    for (let i = 0; i < 3; i++) {
      await pool.run(async (url) => {
        used.push(url)
      })
    }
    expect(used).toEqual(['http://b', 'http://b', 'http://b'])
  })

  it('期限が過ぎたら、外れた台を 1 回だけ試し、成功すれば復帰する', async () => {
    const c = clock()
    const pool = createPool(cfgOf(['http://a', 'http://b']), c.now)
    await pool.run(async (url) => {
      if (url === 'http://a') throw new Error('500')
    })
    // A は外れているので B。期限後は A が選ばれる（この時点で A は成功する）
    c.advance(OUT_MS + 1)
    const url = await pool.run(async (u) => u)
    expect(url).toBe('http://a')
  })

  it('期限後に試した台がまた失敗したら、再び外れる', async () => {
    const c = clock()
    const pool = createPool(cfgOf(['http://a', 'http://b']), c.now)
    await pool.run(async (url) => {
      if (url === 'http://a') throw new Error('500')
    })
    c.advance(OUT_MS + 1)
    // 期限後の 1 回目は A を試して失敗 → 再び外れ、今度は B だけが使われる
    await pool.run(async (url) => {
      if (url === 'http://a') throw new Error('500')
    })
    const used: string[] = []
    await pool.run(async (url) => {
      used.push(url)
    })
    expect(used).toEqual(['http://b'])
  })

  it('両方失敗したら vlm（数値にならない）', async () => {
    const pool = createPool(cfgOf(['http://a', 'http://b']), clock().now)
    const err = await pool
      .run(async () => {
        throw new Error('500')
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CheckError)
    expect((err as CheckError).kind).toBe('vlm')
  })
})

describe('VLM_BASE_URLS / VLM_SLOTS_PER_BACKEND の正規化', () => {
  it('空要素・重複・末尾の / と /v1 を正規化する', () => {
    const c = loadConfig(
      { VLM_BASE_URLS: ' http://a:8080/ , ,http://a:8080, http://b:8080/v1/ ' },
      '.',
    )
    expect(c.vlmBaseUrls).toEqual(['http://a:8080', 'http://b:8080'])
  })

  it('VLM_BASE_URLS 未設定なら VLM_BASE_URL の 1 件、既定は 127.0.0.1:8080 の 1 件', () => {
    expect(loadConfig({ VLM_BASE_URL: 'http://x:9/' }, '.').vlmBaseUrls).toEqual(['http://x:9'])
    expect(loadConfig({}, '.').vlmBaseUrls).toEqual(['http://127.0.0.1:8080'])
  })

  it('VLM_SLOTS_PER_BACKEND の既定は 1、数値を読む', () => {
    expect(loadConfig({}, '.').vlmSlotsPerBackend).toBe(1)
    expect(loadConfig({ VLM_SLOTS_PER_BACKEND: '3' }, '.').vlmSlotsPerBackend).toBe(3)
  })
})
