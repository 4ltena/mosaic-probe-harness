import { describe, expect, it, vi } from 'vitest'
import { check, checkDetail, checkResult, type CheckDeps } from '../src/check.ts'
import { defaultConfig } from '../src/config.ts'
import { CheckError, type Judge, type Probs4 } from '../src/types.ts'

const SRC = new Uint8Array([1, 2, 3])
const cfg = defaultConfig()
const probs = (ok: number): Probs4 => ({ none: 0, processed: ok, forgot: 1 - ok, nori: 0 })
const variants = (n: number) =>
  async () => Array.from({ length: n }, (_, i) => ({ description: `v${i}`, render: async () => new Uint8Array([i]) }))

function deps(values: Probs4[], overrides: Partial<CheckDeps> = {}): CheckDeps {
  return {
    renderVariants: variants(values.length),
    normalize: async (data) => data,
    judges: [{ name: 'default', weight: 1, judge: async (data) => values[data[0]!]! }],
    ...overrides,
  }
}

describe('check', () => {
  it('全描画の最小値と、その描画の詳細を返す', async () => {
    const d = deps([probs(0.9), { none: 0.1, processed: 0.2, forgot: 0.5, nori: 0.2 }, probs(0.8)])
    const { detail, q } = await checkResult(SRC, cfg, d)
    expect(detail.pOk).toBeCloseTo(0.3 / 0.8)
    expect(detail.pOk).toBe(await check(SRC, cfg, d))
    expect(q).toBeCloseTo(0.5 / 0.8)
    expect(detail.render).toBe('v1')
    expect(detail.judgment).toBe('forgot')
    expect(detail.confidence).toBeCloseTo(0.5)
    expect(detail.classes.ok).toBeCloseTo(0.3)
    expect(detail.perModel.default?.processed).toBe(0.2)
  })

  it('描画が 0 件なら bad_input', async () => {
    await expect(check(SRC, cfg, deps([]))).rejects.toMatchObject({ kind: 'bad_input' })
  })

  it('予期しない例外は internal', async () => {
    const normalize = async () => { throw new TypeError('想定外') }
    await expect(check(SRC, cfg, deps([probs(0.8)], { normalize }))).rejects.toMatchObject({ kind: 'internal' })
  })

  it('既定は直列で、スロットを増やすと描画を並行処理する', async () => {
    for (const slots of [1, 2]) {
      let active = 0
      let max = 0
      const judge = vi.fn(async () => {
        max = Math.max(max, ++active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active--
        return probs(0.8)
      })
      const d = deps(Array.from({ length: 5 }, () => probs(0.8)), { judges: [{ name: 'm', weight: 1, judge }] })
      const result = await checkDetail(SRC, defaultConfig({ vlmSlotsPerBackend: slots }), d)
      expect(max).toBe(slots)
      expect(judge).toHaveBeenCalledTimes(5)
      expect(result.render).toBe('v0')
    }
  })

  it('1 件でも失敗したら残りを中止し、数値を返さない', async () => {
    const fail = new CheckError('vlm', 'モデルが応答しません')
    const judge: Judge['judge'] = async (png) => {
      if (png[0] === 2) throw fail
      return probs(0.8)
    }
    const tracked = vi.fn(judge)
    const d = deps(Array.from({ length: 6 }, () => probs(0.8)), { judges: [{ name: 'm', weight: 1, judge: tracked }] })
    await expect(checkDetail(SRC, cfg, d)).rejects.toBe(fail)
    expect(tracked).toHaveBeenCalledTimes(3)
  })

  it('クライアント切断後は次の描画を送信しない', async () => {
    const ac = new AbortController()
    const reason = new Error('切断')
    const judge = vi.fn(async () => {
      ac.abort(reason)
      return probs(0.8)
    })
    const d = deps(Array.from({ length: 5 }, () => probs(0.8)), { judges: [{ name: 'm', weight: 1, judge }] })
    await expect(check(SRC, cfg, d, ac.signal)).rejects.toBe(reason)
    expect(judge).toHaveBeenCalledTimes(1)
    await expect(check(SRC, cfg, d, ac.signal)).rejects.toBe(ac.signal.reason)
    expect(judge).toHaveBeenCalledTimes(1)
  })
})

describe('再判定', () => {
  const on = defaultConfig({ recheck: true, recheckLo: 0.2, recheckHi: 0.9 })

  it('指定範囲で p_ok だけを下げる。詳細は元の描画のもの', async () => {
    const recheck = vi.fn(async () => 0.3)
    const result = await checkDetail(SRC, on, deps([probs(0.85), probs(0.5)], { recheck }))
    expect(recheck).toHaveBeenCalledOnce()
    expect(result.pOk).toBe(0.3)
    expect(result.render).toBe('v1')
    expect(result.classes).toEqual({ ok: 0.5, forgot: 0.5, nori: 0 })
  })

  it('無効または範囲外なら実行せず、再判定の高い値は採用しない', async () => {
    const recheck = vi.fn(async () => 0.99)
    await check(SRC, cfg, deps([probs(0.5)], { recheck }))
    await check(SRC, on, deps([probs(0.1)], { recheck }))
    await check(SRC, on, deps([probs(0.95)], { recheck }))
    expect(recheck).not.toHaveBeenCalled()
    await expect(check(SRC, on, deps([probs(0.5)], { recheck }))).resolves.toBe(0.5)
    expect(recheck).toHaveBeenCalledOnce()
  })

  it('指示用チャットの例外は一次判定を採用し、切り出した画像の判定失敗は返す', async () => {
    const recheck = async () => { throw new Error('チャット失敗') }
    await expect(check(SRC, on, deps([probs(0.5)], { recheck }))).resolves.toBe(0.5)
    const fail = new CheckError('vlm', 'モデルが応答しません')
    const failed = async () => { throw fail }
    await expect(check(SRC, on, deps([probs(0.5)], { recheck: failed }))).rejects.toBe(fail)
  })
})
