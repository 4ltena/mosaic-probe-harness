import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Calibrator, aggregate, chooseThresholds, judge4, label, reliability } from '../src/probability.ts'
import type { Probs4 } from '../src/types.ts'

const logLoss = (ps: number[], ys: number[]): number => {
  let s = 0
  ps.forEach((p0, i) => {
    const p = Math.min(Math.max(p0, 1e-12), 1 - 1e-12)
    s -= ys[i] === 1 ? Math.log(p) : Math.log(1 - p)
  })
  return s / ps.length
}

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
      expect(loaded.toJSON()).toEqual({ version: 'v1.1', a: 1, b: 0 })

      const path = join(dir, 'calibration.json')
      writeFileSync(path, JSON.stringify({ a: 0.5, b: -0.25 }))
      expect(Calibrator.load(path).apply(0.2)).toBe(0.2)
      const fitted = new Calibrator(0.5, -0.25)
      writeFileSync(path, JSON.stringify(fitted.toJSON()), 'utf8')
      const back = Calibrator.load(path)
      expect(back.toJSON()).toEqual({ version: 'v1.1', a: 0.5, b: -0.25 })
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 'v1.1', a: 0.5, b: -0.25 })
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


describe('aggregate', () => {
  it('重みつき平均する（重み 1 と 3 なら 1:3）', () => {
    const a: Probs4 = { none: 1, processed: 0, forgot: 0, nori: 0 }
    const b: Probs4 = { none: 0, processed: 0, forgot: 1, nori: 0 }
    const r = aggregate([
      { probs: a, weight: 1 },
      { probs: b, weight: 3 },
    ])
    expect(r.none).toBeCloseTo(0.25, 9)
    expect(r.forgot).toBeCloseTo(0.75, 9)
    expect(r.processed + r.nori).toBeCloseTo(0, 9)
  })

  it('結果の合計は 1', () => {
    const r = aggregate([
      { probs: { none: 0.2, processed: 0.3, forgot: 0.4, nori: 0.1 }, weight: 2 },
      { probs: { none: 0.6, processed: 0.1, forgot: 0.1, nori: 0.2 }, weight: 1 },
    ])
    expect(r.none + r.processed + r.forgot + r.nori).toBeCloseTo(1, 9)
  })

  it('空・負の重み・合計 0 は例外', () => {
    const p: Probs4 = { none: 1, processed: 0, forgot: 0, nori: 0 }
    expect(() => aggregate([])).toThrow()
    expect(() => aggregate([{ probs: p, weight: -1 }])).toThrow()
    expect(() => aggregate([{ probs: p, weight: 0 }])).toThrow()
  })
})

describe('judge4（仕様 §1 の式）', () => {
  // okMass 0.7（none + processed）、forgot 0.25、nori 0.05
  const P: Probs4 = { none: 0.1, processed: 0.6, forgot: 0.25, nori: 0.05 }

  it('okMass と ngMass と classes', () => {
    const r = judge4(P)
    expect(r.okMass).toBeCloseTo(0.7, 9)
    expect(r.ngMass).toBeCloseTo(0.25, 9)
    expect(r.classes.ok).toBeCloseTo(0.7, 9)
    expect(r.classes.forgot).toBeCloseTo(0.25, 9)
    expect(r.classes.nori).toBeCloseTo(0.05, 9)
  })

  it('pOk（恒等較正）は okMass / (okMass + ngMass)', () => {
    expect(judge4(P).pOk).toBeCloseTo(0.7 / 0.95, 9)
  })

  it('okMass ≥ ngMass なら judgment は ok、confidence は okMass', () => {
    const r = judge4(P)
    expect(r.judgment).toBe('ok')
    expect(r.confidence).toBeCloseTo(0.7, 9)
  })

  it('NG 側が勝つとき judgment は多い方の NG 種（nori）、confidence は ngMass', () => {
    const r = judge4({ none: 0, processed: 0.2, forgot: 0.1, nori: 0.7 })
    expect(r.judgment).toBe('nori')
    expect(r.confidence).toBeCloseTo(0.7, 9)
  })

  it('NG 側が勝ち forgot が多ければ judgment は forgot', () => {
    const r = judge4({ none: 0, processed: 0.1, forgot: 0.8, nori: 0.1 })
    expect(r.judgment).toBe('forgot')
    expect(r.confidence).toBeCloseTo(0.8, 9)
  })

  it('ngMass は forgot と nori の大きい方（小さい方ではない）', () => {
    const r = judge4({ none: 0, processed: 0.6, forgot: 0.1, nori: 0.3 })
    expect(r.ngMass).toBeCloseTo(0.3, 9)
    expect(r.pOk).toBeCloseTo(0.6 / 0.9, 9)
  })

  it('同率: okMass ≥ ngMass なら ok、NG 側同士なら forgot', () => {
    expect(judge4({ none: 0, processed: 0.5, forgot: 0.25, nori: 0.25 }).judgment).toBe('ok')
    expect(judge4({ none: 0, processed: 0.25, forgot: 0.375, nori: 0.375 }).judgment).toBe('forgot')
  })

  it('対象なし（none = 1）なら pOk は 1', () => {
    expect(judge4({ none: 1, processed: 0, forgot: 0, nori: 0 }).pOk).toBe(1)
  })

  it('全て 0 は例外（数値を返さない）', () => {
    expect(() => judge4({ none: 0, processed: 0, forgot: 0, nori: 0 })).toThrow()
  })
})

describe('pOkCal（較正を通す版）', () => {
  const P: Probs4 = { none: 0.1, processed: 0.6, forgot: 0.25, nori: 0.05 }

  it('恒等較正なら judge4 の pOk と一致', () => {
    expect(judge4(P, new Calibrator()).pOk).toBeCloseTo(judge4(P).pOk, 9)
  })

  it('較正は q = ngMass/(okMass+ngMass) に掛け、p_ok = 1 − cal(q)', () => {
    const cal = new Calibrator(1, 1)
    const q = 0.25 / 0.95
    expect(judge4(P, cal).pOk).toBeCloseTo(1 - cal.apply(q), 9)
    expect(judge4(P, cal).pOk).not.toBeCloseTo(judge4(P).pOk, 3)
  })
})
