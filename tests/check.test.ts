import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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

describe('前段の検出（DETECT=1）', () => {
  const on = defaultConfig({ detect: true })
  const NG2: Probs4 = { none: 0.1, processed: 0.1, forgot: 0.2, nori: 0.6 }

  /** 描画と切り出しを先頭のバイトで表す。判定器は table[バイト] を返し、crops は描画のバイトから切り出しのバイトを引く。 */
  function setup(table: Probs4[], renders: number[], parts: Record<number, number[]>, overrides: Partial<CheckDeps> = {}) {
    const judge = vi.fn(async (png: Uint8Array) => table[png[0]!]!)
    const crops = vi.fn(async (png: Uint8Array, _signal: AbortSignal) => (parts[png[0]!] ?? []).map((b) => new Uint8Array([b])))
    const d: CheckDeps = {
      renderVariants: async () => renders.map((b, i) => ({ description: `v${i}`, render: async () => new Uint8Array([b]) })),
      normalize: async (data) => data,
      judges: [{ name: 'm', weight: 1, judge }],
      crops,
      ...overrides,
    }
    return { d, judge, crops }
  }

  it('既定オフ: DETECT=0 なら crops を渡しても呼ばず、判定は描画の数だけ', async () => {
    const { d, judge, crops } = setup([probs(0.9), probs(0.1)], [0], { 0: [1] })
    expect((await checkDetail(SRC, cfg, d)).pOk).toBeCloseTo(0.9)
    expect(crops).not.toHaveBeenCalled()
    expect(judge).toHaveBeenCalledOnce()
    // DETECT=1 でも crops がなければ、今と同じ
    expect((await checkDetail(SRC, on, { ...d, crops: undefined })).render).toBe('v0')
  })

  it('既定オフ: check.ts は crops.ts も detect.ts も import せず、src と eval に detect.ts の静的な import がない', () => {
    const check = readFileSync('src/check.ts', 'utf8')
    expect(check).not.toMatch(/from\s+['"][^'"]*\/(crops|detect)\.ts['"]/u)
    const offenders: string[] = []
    for (const dir of ['src', 'eval']) {
      for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts') && n !== 'detect.ts')) {
        const text = readFileSync(join(dir, name), 'utf8')
        // import type は消える。import { type X } は消えずに読み込むので違反として扱う
        for (const m of text.matchAll(/^import\s+(?!type\s)[^'"]*?from\s+['"][^'"]*\/detect\.ts['"]/gmu)) {
          offenders.push(`${dir}/${name}: ${m[0]}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('NG の反映: 全体が ok でも、切り出しが NG なら NG', async () => {
    const { d, judge } = setup([probs(0.9), probs(0.2)], [0], { 0: [1] })
    const { detail, q } = await checkResult(SRC, on, d)
    expect(detail.pOk).toBeCloseTo(0.2)
    expect(q).toBeCloseTo(0.8)
    expect(detail.judgment).toBe('forgot')
    expect(detail.render).toBe('v0の切り出し 1')
    expect(judge).toHaveBeenCalledTimes(2)
  })

  it('render と順位: 2 件目の切り出しが最悪なら、その候補の judgment・classes・per_model・q がそろって出る', async () => {
    const { d } = setup([probs(0.9), probs(0.7), NG2], [0], { 0: [1, 2] })
    const { detail, q } = await checkResult(SRC, on, d)
    expect(detail.render).toBe('v0の切り出し 2')
    expect(detail.pOk).toBeCloseTo(0.2 / 0.8)
    expect(q).toBeCloseTo(0.6 / 0.8)
    expect(detail.judgment).toBe('nori')
    expect(detail.confidence).toBeCloseTo(0.6)
    expect(detail.classes.ok).toBeCloseTo(0.2)
    expect(detail.classes.nori).toBeCloseTo(0.6)
    expect(detail.perModel).toEqual({ m: NG2 })
  })

  it('順位: p_ok が同じなら全体を選び、描画どうしでは番号の小さい方を選ぶ', async () => {
    // 描画 0 の全体と切り出しが同じ値 → 全体
    expect((await checkDetail(SRC, on, setup([probs(0.4), probs(0.4)], [0], { 0: [1] }).d)).render).toBe('v0')
    // 描画 1 の全体と描画 0 の切り出しが同じ値 → 描画 0 の切り出し（描画の番号が先）
    const { d } = setup([probs(0.9), probs(0.4), probs(0.4)], [0, 1], { 0: [2] })
    expect((await checkDetail(SRC, on, d)).render).toBe('v0の切り出し 1')
  })

  it('切り出しは worker の中で 1 件ずつ判定する（同時の判定数は min(描画数, スロット) のまま）', async () => {
    let active = 0
    let max = 0
    const judge = vi.fn(async (png: Uint8Array) => {
      max = Math.max(max, ++active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return probs(png[0] === 0 ? 0.9 : 0.5)
    })
    const { d } = setup([], [0], { 0: [1, 2, 3] }, { judges: [{ name: 'm', weight: 1, judge }] })
    await checkDetail(SRC, defaultConfig({ detect: true, vlmSlotsPerBackend: 4 }), d)
    expect(judge).toHaveBeenCalledTimes(4)
    expect(max).toBe(1)
  })

  describe('再判定', () => {
    const rc = defaultConfig({ detect: true, recheck: true, recheckLo: 0, recheckHi: 1 })
    const table = [probs(0.85), probs(0.5), probs(0.1)]

    it('最悪が切り出しでも、再判定は全体の最悪の描画に対して動き、切り出しを渡さない。最終の p_ok は DETECT=0 以下', async () => {
      const recheck = vi.fn(async (_png: Uint8Array, _p: number) => 0.3)
      const { d } = setup(table, [0, 1], { 0: [2] }, { recheck })
      const result = await checkDetail(SRC, rc, d)
      expect(recheck).toHaveBeenCalledOnce()
      expect([...recheck.mock.calls[0]![0]]).toEqual([1])
      expect(recheck.mock.calls[0]![1]).toBeCloseTo(0.5)
      expect(result.render).toBe('v0の切り出し 1')
      expect(result.pOk).toBeCloseTo(0.1)
      const off = await checkDetail(SRC, defaultConfig({ recheck: true, recheckLo: 0, recheckHi: 1 }), d)
      expect(off.pOk).toBe(0.3)
      expect(result.pOk).toBeLessThanOrEqual(off.pOk)
    })

    it('再判定で全体が切り出しより低くなれば、全体の候補（p_ok だけ下がる）を採る', async () => {
      const recheck = vi.fn(async () => 0.05)
      const result = await checkDetail(SRC, rc, setup(table, [0, 1], { 0: [2] }, { recheck }).d)
      expect(result.pOk).toBe(0.05)
      expect(result.render).toBe('v1')
      expect(result.classes.ok).toBeCloseTo(0.5)
    })
  })

  it('失敗: 分類・検出・切り出しの失敗は internal、切り出しの判定の失敗は vlm', async () => {
    const table = [probs(0.9), probs(0.5)]
    for (const thrown of [new Error('検出の失敗'), new CheckError('internal', '出力に NaN')]) {
      const crops = async () => { throw thrown }
      await expect(check(SRC, on, setup(table, [0], {}, { crops }).d)).rejects.toMatchObject({ kind: 'internal' })
    }
    const fail = new CheckError('vlm', 'モデルが応答しません')
    const judge = async (png: Uint8Array) => {
      if (png[0] === 1) throw fail
      return probs(0.9)
    }
    const d = setup(table, [0], { 0: [1] }, { judges: [{ name: 'm', weight: 1, judge }] }).d
    await expect(check(SRC, on, d)).rejects.toBe(fail)
  })

  it('中断: 検出の中で中断すると、切り出しの判定を 1 件も送らず、中断の理由をそのまま返す（internal にしない）', async () => {
    for (const throws of [true, false]) {
      const ac = new AbortController()
      const reason = new Error('切断')
      const crops = vi.fn(async (_png: Uint8Array, signal: AbortSignal) => {
        ac.abort(reason)
        if (throws) signal.throwIfAborted()
        return [new Uint8Array([1])]
      })
      const { d, judge } = setup([probs(0.9), probs(0.1)], [0, 0], {}, { crops })
      await expect(check(SRC, on, d, ac.signal)).rejects.toBe(reason)
      expect(crops).toHaveBeenCalledOnce()
      expect(judge).toHaveBeenCalledOnce()
    }
  })

  it('中断: 切り出しの判定の途中で中断しても、残りを送らず、中断の理由を返す', async () => {
    const ac = new AbortController()
    const reason = new Error('切断')
    const judge = vi.fn(async (png: Uint8Array) => {
      if (png[0] === 1) ac.abort(reason)
      return probs(0.9)
    })
    const { d } = setup([], [0], { 0: [1, 2, 3] }, { judges: [{ name: 'm', weight: 1, judge }] })
    await expect(check(SRC, on, d, ac.signal)).rejects.toBe(reason)
    expect(judge).toHaveBeenCalledTimes(2)
  })
})
