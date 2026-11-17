import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Calibrator, chooseThresholds, label, pOk, reliability } from '../src/probability.ts'

const logLoss = (ps: number[], ys: number[]): number => {
  let s = 0
  ps.forEach((p0, i) => {
    const p = Math.min(Math.max(p0, 1e-12), 1 - 1e-12)
    s -= ys[i] === 1 ? Math.log(p) : Math.log(1 - p)
  })
  return s / ps.length
}

describe('pOk', () => {
  it('OK 寄りの分布で p_ok は 0.05 近く（恒等較正）', () => {
    expect(pOk({ none: 0, ok: 0.05, ng: 0.95 }, new Calibrator())).toBeCloseTo(0.05, 9)
  })

  it('B 寄りの分布で p_ok は 0.99 近く', () => {
    expect(pOk({ none: 0, ok: 0.99, ng: 0.01 }, new Calibrator())).toBeCloseTo(0.99, 9)
  })

  it('対象なし（A=1）は p_ok = 1.0', () => {
    expect(pOk({ none: 1, ok: 0, ng: 0 }, new Calibrator())).toBe(1.0)
  })

  it('対象ありと無しが半々なら p_ok は 0.5 近く', () => {
    expect(pOk({ none: 0.5, ok: 0, ng: 0.5 }, new Calibrator())).toBeCloseTo(0.5, 9)
  })

  it('ok+ng == 0 でも例外にならず 1.0', () => {
    expect(pOk({ none: 0, ok: 0, ng: 0 }, new Calibrator())).toBe(1.0)
  })

  it('任意の入力で常に 0〜1 の有限値', () => {
    const cal = new Calibrator()
    const cases = [
      { none: 0, ok: 1, ng: 0 },
      { none: 0, ok: 0, ng: 1 },
      { none: 0.3, ok: 0.7, ng: 0 },
      { none: 0.2, ok: 0.4, ng: 0.4 },
      { none: 0, ok: 0.5, ng: 0.5 },
    ]
    for (const c of cases) {
      const v = pOk(c, cal)
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('Calibrator', () => {
  it('既定は恒等で、端点も有限', () => {
    const cal = new Calibrator()
    for (const q of [0.1, 0.5, 0.9]) expect(cal.apply(q)).toBeCloseTo(q, 9)
    expect(Number.isFinite(cal.apply(0))).toBe(true)
    expect(Number.isFinite(cal.apply(1))).toBe(true)
  })

  it('過信データ（0.02/0.98 に押し込んだ 200 点）で fit すると対数損失が恒等より小さい', () => {
    const qs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < 200; i++) {
      const high = i % 2 === 0
      qs.push(high ? 0.98 : 0.02)
      // 高い側は 70% が 1、低い側は 20% が 1（決定的に配分）
      ys.push(high ? (i % 10 < 7 ? 1 : 0) : (i % 10 < 2 ? 1 : 0))
    }
    const cal = Calibrator.fit(qs, ys)
    const identity = new Calibrator()
    const calibrated = qs.map((q) => cal.apply(q))
    const raw = qs.map((q) => identity.apply(q))
    expect(logLoss(calibrated, ys)).toBeLessThan(logLoss(raw, ys))
  })

  it('load はファイルが無ければ恒等、toJSON は往復できる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probability-test-'))
    try {
      const missing = join(dir, 'none.json')
      const loaded = Calibrator.load(missing)
      expect(loaded.toJSON()).toEqual({ a: 1, b: 0 })

      const path = join(dir, 'calibration.json')
      const fitted = new Calibrator(0.5, -0.25)
      writeFileSync(path, JSON.stringify(fitted.toJSON()), 'utf8')
      const back = Calibrator.load(path)
      expect(back.toJSON()).toEqual({ a: 0.5, b: -0.25 })
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 0.5, b: -0.25 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('label', () => {
  it('p_ok 0.95 は pass、0.05 は stop、0.7 は hold（閾値 0.1 / 0.5）', () => {
    expect(label(0.95, 0.1, 0.5)).toBe('pass')
    expect(label(0.05, 0.1, 0.5)).toBe('stop')
    expect(label(0.7, 0.1, 0.5)).toBe('hold')
  })
})

describe('reliability', () => {
  it('完全に較正されたデータで ECE は 0 近く', () => {
    const qs: number[] = []
    const ys: number[] = []
    // 各ビンの中心値 p について 20 件中 round(p*20) 件を 1 にする
    for (let k = 0; k < 10; k++) {
      const p = k / 10 + 0.05
      const ones = Math.round(p * 20)
      for (let j = 0; j < 20; j++) {
        qs.push(p)
        ys.push(j < ones ? 1 : 0)
      }
    }
    const r = reliability(qs, ys)
    expect(r.ece).toBeLessThan(1e-9)
    expect(r.bins).toHaveLength(10)
  })

  it('過信データで ECE が大きい', () => {
    const qs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < 200; i++) {
      qs.push(i % 2 === 0 ? 0.98 : 0.02)
      ys.push(i % 2 === 0 ? (i % 4 === 0 ? 1 : 0) : (i % 4 === 1 ? 1 : 0))
    }
    expect(reliability(qs, ys).ece).toBeGreaterThan(0.3)
  })
})

describe('chooseThresholds', () => {
  it('NG の p_ng [.6,.9] と OK の p_ng [.01,.05] から [0.3, 0.5] を返す', () => {
    const [tOk, tNg] = chooseThresholds([0.6, 0.9], [0.01, 0.05])
    expect(tOk).toBeCloseTo(0.3, 9)
    expect(tNg).toBeCloseTo(0.5, 9)
  })
})
