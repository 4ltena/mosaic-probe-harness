import { describe, expect, it } from 'vitest'
import { check, checkDetail, type CheckDeps } from '../src/check.ts'
import { defaultConfig } from '../src/config.ts'
import { CheckError, type ClassProbs } from '../src/types.ts'

const SRC = new Uint8Array([1, 2, 3])
const cfg = defaultConfig({ maxRenders: 8, layerPattern: 'x', maxPixels: 1000, maxEdge: 64 })

// 描画 n 件の偽。image は中身を見ないのでダミー
const renders = (n: number) =>
  async () =>
    Array.from({ length: n }, (_, i) => ({ description: `v${i}`, image: new Uint8Array([i]) }))

// normalize は恒等に近い偽（呼ばれた入力をそのまま JPEG とみなす）
const identity = async (d: Uint8Array) => d

// judge: 呼ばれた順に用意した確率を返す
const seqJudge = (list: ClassProbs[]) => {
  let i = 0
  return async (_jpeg: Uint8Array): Promise<ClassProbs> => {
    const v = list[i++]
    if (!v) throw new Error('judge の呼び出しが想定より多い')
    return v
  }
}

// 確率は judge の戻りをそのまま使い、pOk の戻りを別表で決める（順番で 0.9 / 0.2 / 0.8 を返す）
const seqPOk = (vals: number[]) => {
  let i = 0
  return (_p: ClassProbs): number => {
    const v = vals[i++]
    if (v === undefined) throw new Error('pOk の呼び出しが想定より多い')
    return v
  }
}

const dummyProbs: ClassProbs = { none: 0.1, ok: 0.1, ng: 0.8 }
const judgeN = (n: number): ClassProbs[] => Array.from({ length: n }, () => dummyProbs)

const deps = (over: Partial<CheckDeps>): CheckDeps => ({
  renderVariants: over.renderVariants ?? (renders(1) as CheckDeps['renderVariants']),
  normalize: over.normalize ?? (identity as CheckDeps['normalize']),
  judge: over.judge ?? seqJudge(judgeN(10)),
  pOk: over.pOk ?? seqPOk([0.5]),
  recheck: over.recheck,
  log: over.log,
})

describe('check', () => {
  it('描画 3 件の pOk が 0.9 / 0.2 / 0.8 → 戻りは 0.2（最小値）', async () => {
    const r = await check(
      SRC,
      cfg,
      deps({
        renderVariants: renders(3) as CheckDeps['renderVariants'],
        judge: seqJudge(judgeN(3)),
        pOk: seqPOk([0.9, 0.2, 0.8]),
      }),
    )
    expect(r).toBe(0.2)
  })

  it('描画が 0 件 → CheckError("bad_input")', async () => {
    const err = await check(
      SRC,
      cfg,
      deps({ renderVariants: renders(0) as CheckDeps['renderVariants'], judge: seqJudge([]) }),
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CheckError)
    expect((err as CheckError).kind).toBe('bad_input')
  })

  it('3 件目の judge が CheckError("vlm") → 同じエラーで、数値を返さない', async () => {
    let calls = 0
    const judge = async (_j: Uint8Array): Promise<ClassProbs> => {
      calls++
      if (calls === 3) throw new CheckError('vlm', 'llama-server が応答しません')
      return dummyProbs
    }
    const err = await check(
      SRC,
      cfg,
      deps({ renderVariants: renders(3) as CheckDeps['renderVariants'], judge, pOk: seqPOk([0.9, 0.9, 0.9]) }),
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CheckError)
    expect((err as CheckError).kind).toBe('vlm')
  })

  it('CheckError 以外の例外は CheckError("internal") に包む', async () => {
    const judge = async (): Promise<ClassProbs> => {
      throw new TypeError('想定外')
    }
    const err = await check(
      SRC,
      cfg,
      deps({ renderVariants: renders(1) as CheckDeps['renderVariants'], judge }),
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CheckError)
    expect((err as CheckError).kind).toBe('internal')
  })

  // judge の同時実行数を数える偽。確率は一定の 0.5
  const countingJudge = (delayMs: number) => {
    const s = { active: 0, max: 0, calls: 0 }
    const judge = async (_j: Uint8Array): Promise<ClassProbs> => {
      s.calls++
      s.active++
      s.max = Math.max(s.max, s.active)
      await new Promise((r) => setTimeout(r, delayMs))
      s.active--
      return dummyProbs
    }
    return { s, judge }
  }
  const pOkFixed = () => 0.5

  it('既定（1 台・スロット 1）は直列: judge の同時実行数の最大は 1', async () => {
    const { s, judge } = countingJudge(5)
    await check(SRC, cfg, deps({ renderVariants: renders(3) as CheckDeps['renderVariants'], judge, pOk: pOkFixed }))
    expect(s.max).toBe(1)
    expect(s.calls).toBe(3)
  })

  it('総スロット数（台 × スロット）まで並列、上限は超えない。最小値は変わらない', async () => {
    const pcfg = defaultConfig({ maxRenders: 8, layerPattern: 'x', maxPixels: 1000, maxEdge: 64, vlmBaseUrls: ['http://a', 'http://b'], vlmSlotsPerBackend: 2 })
    const { s, judge } = countingJudge(10)
    const r = await check(
      SRC,
      pcfg,
      deps({ renderVariants: renders(5) as CheckDeps['renderVariants'], judge, pOk: pOkFixed }),
    )
    expect(s.max).toBeGreaterThan(1)
    expect(s.max).toBeLessThanOrEqual(4)
    expect(s.calls).toBe(5)
    expect(r).toBe(0.5)
  })

  it('1 件でも判定が失敗したら、残りを中止して CheckError を返す', async () => {
    const pcfg = defaultConfig({ maxRenders: 8, layerPattern: 'x', maxPixels: 1000, maxEdge: 64, vlmBaseUrls: ['http://a'], vlmSlotsPerBackend: 2 })
    let calls = 0
    const judge = async (_j: Uint8Array): Promise<ClassProbs> => {
      calls++
      if (calls === 1) throw new CheckError('vlm', '応答なし')
      await new Promise((r) => setTimeout(r, 30))
      return dummyProbs
    }
    const err = await check(SRC, pcfg, deps({ renderVariants: renders(6) as CheckDeps['renderVariants'], judge, pOk: pOkFixed })).catch(
      (e: unknown) => e,
    )
    expect((err as CheckError).kind).toBe('vlm')
    expect(calls).toBeLessThan(6)
  })

  it('signal が abort されたら、以降の描画の判定を呼ばずに終わる', async () => {
    const ac = new AbortController()
    let calls = 0
    const judge = async (_j: Uint8Array, signal?: AbortSignal): Promise<ClassProbs> => {
      calls++
      ac.abort()
      signal?.throwIfAborted()
      return dummyProbs
    }
    await expect(
      check(SRC, cfg, deps({ renderVariants: renders(5) as CheckDeps['renderVariants'], judge, pOk: pOkFixed }), ac.signal),
    ).rejects.toBeDefined()
    expect(calls).toBe(1)
  })

  describe('再判定', () => {
    const recheckCfg = defaultConfig({
      recheck: true,
      recheckLo: 0.2,
      recheckHi: 0.9,
      maxRenders: 8,
      layerPattern: 'x',
      maxPixels: 1000,
      maxEdge: 64,
    })

    it('p が範囲内のときだけ recheck が呼ばれる', async () => {
      const calledWith: number[] = []
      const recheck = async (_j: Uint8Array, p: number) => {
        calledWith.push(p)
        return p
      }
      // 範囲外 0.1 → 呼ばれない
      await check(SRC, recheckCfg, deps({ judge: seqJudge(judgeN(1)), pOk: seqPOk([0.1]), recheck }))
      // 範囲外 0.95 → 呼ばれない
      await check(SRC, recheckCfg, deps({ judge: seqJudge(judgeN(1)), pOk: seqPOk([0.95]), recheck }))
      expect(calledWith).toEqual([])
      // 範囲内 0.5 → 呼ばれる
      await check(SRC, recheckCfg, deps({ judge: seqJudge(judgeN(1)), pOk: seqPOk([0.5]), recheck }))
      expect(calledWith).toEqual([0.5])
    })

    it('recheck の戻りが p より大きくても下がらない（上がらない）', async () => {
      const r = await check(
        SRC,
        recheckCfg,
        deps({ judge: seqJudge(judgeN(1)), pOk: seqPOk([0.5]), recheck: async () => 0.99 }),
      )
      expect(r).toBe(0.5)
    })

    it('recheck の戻りが p より小さければ下がる', async () => {
      const r = await check(
        SRC,
        recheckCfg,
        deps({ judge: seqJudge(judgeN(1)), pOk: seqPOk([0.5]), recheck: async () => 0.3 }),
      )
      expect(r).toBe(0.3)
    })

    it('recheck が例外を投げたら p を採用', async () => {
      const r = await check(
        SRC,
        recheckCfg,
        deps({
          judge: seqJudge(judgeN(1)),
          pOk: seqPOk([0.5]),
          recheck: async () => {
            throw new Error('agent 失敗')
          },
        }),
      )
      expect(r).toBe(0.5)
    })

    it('cfg.recheck が false なら recheck は呼ばれない', async () => {
      let called = false
      const off = defaultConfig({ recheck: false, recheckLo: 0.2, recheckHi: 0.9, maxRenders: 8, layerPattern: 'x', maxPixels: 1000, maxEdge: 64 })
      const r = await check(
        SRC,
        off,
        deps({
          judge: seqJudge(judgeN(1)),
          pOk: seqPOk([0.5]),
          recheck: async () => {
            called = true
            return 0.1
          },
        }),
      )
      expect(called).toBe(false)
      expect(r).toBe(0.5)
    })
  })
})

// 種類つきの判定結果を作る（ng は 3 種類の合計）
const kindsProbs = (none: number, ok: number, forgot: number, insufficient: number, nori: number): ClassProbs => ({
  none,
  ok,
  ng: forgot + insufficient + nori,
  kinds: { forgot, insufficient, nori },
})

describe('checkDetail', () => {
  const pOkOf = (p: ClassProbs) => p.ok

  it('3 描画で p_ok が最小の描画の render と classes を返す', async () => {
    const probs: ClassProbs[] = [
      kindsProbs(0.01, 0.9, 0.05, 0.03, 0.01),
      kindsProbs(0.02, 0.2, 0.5, 0.2, 0.08),
      kindsProbs(0.0, 0.8, 0.1, 0.05, 0.05),
    ]
    const d = await checkDetail(
      SRC,
      cfg,
      deps({ renderVariants: renders(3) as CheckDeps['renderVariants'], judge: seqJudge(probs), pOk: pOkOf }),
    )
    expect(d.pOk).toBe(0.2)
    expect(d.render).toBe('v1')
    expect(d.classes).toEqual({ none: 0.02, ok: 0.2, forgot: 0.5, insufficient: 0.2, nori: 0.08 })
  })

  it('check は checkDetail.pOk と一致する', async () => {
    const probs: ClassProbs[] = [kindsProbs(0.01, 0.9, 0.05, 0.03, 0.01), kindsProbs(0.02, 0.2, 0.5, 0.2, 0.08)]
    const p = await check(
      SRC,
      cfg,
      deps({ renderVariants: renders(2) as CheckDeps['renderVariants'], judge: seqJudge(probs), pOk: pOkOf }),
    )
    const d = await checkDetail(
      SRC,
      cfg,
      deps({ renderVariants: renders(2) as CheckDeps['renderVariants'], judge: seqJudge(probs), pOk: pOkOf }),
    )
    expect(d.pOk).toBe(p)
  })

  it('kinds が無い judge（古いフェイク）は forgot=ng、insufficient と nori は 0', async () => {
    const d = await checkDetail(
      SRC,
      cfg,
      deps({
        renderVariants: renders(1) as CheckDeps['renderVariants'],
        judge: seqJudge([{ none: 0.1, ok: 0.3, ng: 0.6 }]),
        pOk: pOkOf,
      }),
    )
    expect(d.classes).toEqual({ none: 0.1, ok: 0.3, forgot: 0.6, insufficient: 0, nori: 0 })
  })

  it('noriAsOk のとき、ok に足された nori を引いて生の値に戻す', async () => {
    const nori = defaultConfig({ maxRenders: 8, layerPattern: 'x', maxPixels: 1000, maxEdge: 64, noriAsOk: true })
    // 生: none 0.1 / ok 0.5 / forgot 0.1 / insufficient 0.1 / nori 0.2 → 移動後: ok 0.7, ng 0.2
    const d = await checkDetail(
      SRC,
      nori,
      deps({
        renderVariants: renders(1) as CheckDeps['renderVariants'],
        judge: seqJudge([{ none: 0.1, ok: 0.7, ng: 0.2, kinds: { forgot: 0.1, insufficient: 0.1, nori: 0.2 } }]),
        pOk: pOkOf,
      }),
    )
    expect(d.classes.ok).toBeCloseTo(0.5)
    expect(d.classes.none).toBeCloseTo(0.1)
    expect(d.classes.forgot).toBeCloseTo(0.1)
    expect(d.classes.insufficient).toBeCloseTo(0.1)
    expect(d.classes.nori).toBeCloseTo(0.2)
  })

  it('再判定で p が下がったら pOk だけ下がり、render と classes は元の描画のまま', async () => {
    const recheckCfg = defaultConfig({
      recheck: true,
      recheckLo: 0.2,
      recheckHi: 0.9,
      maxRenders: 8,
      layerPattern: 'x',
      maxPixels: 1000,
      maxEdge: 64,
    })
    const probs = kindsProbs(0.05, 0.5, 0.2, 0.2, 0.05)
    const d = await checkDetail(
      SRC,
      recheckCfg,
      deps({
        renderVariants: renders(1) as CheckDeps['renderVariants'],
        judge: seqJudge([probs]),
        pOk: pOkOf,
        recheck: async () => 0.3,
      }),
    )
    expect(d.pOk).toBe(0.3)
    expect(d.render).toBe('v0')
    expect(d.classes).toEqual({ none: 0.05, ok: 0.5, forgot: 0.2, insufficient: 0.2, nori: 0.05 })
  })

  it('失敗は CheckError で投げ、数値も Detail も返さない', async () => {
    const judge = async (): Promise<ClassProbs> => {
      throw new CheckError('vlm', 'llama-server が応答しません')
    }
    const res = await checkDetail(SRC, cfg, deps({ renderVariants: renders(2) as CheckDeps['renderVariants'], judge })).then(
      (v: unknown) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.e).toBeInstanceOf(CheckError)
    expect((res.e as CheckError).kind).toBe('vlm')
  })
})
