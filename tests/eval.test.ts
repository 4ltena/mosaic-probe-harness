import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { classesOf, kindConfusion, parseLabels, summarize } from '../eval/lib.ts'

// label は T1（src/probability.ts）の担当。未実装でも動くようフェイクを注入する。
// 契約どおり pNg = 1 - p とし、pNg <= tOk で pass、pNg >= tNg で stop、それ以外は hold。
vi.mock('../src/probability.ts', () => ({
  label: (p: number, tOk: number, tNg: number) => {
    const pNg = 1 - p
    if (pNg <= tOk) return 'pass'
    if (pNg >= tNg) return 'stop'
    return 'hold'
  },
}))

const c = (none: number, ok: number, forgot: number, insufficient: number, nori: number) => ({
  none,
  ok,
  forgot,
  insufficient,
  nori,
})

describe('parseLabels', () => {
  it('ヘッダ付き CSV を filename と kind の配列にする', () => {
    expect(parseLabels('filename,kind\na.png,ng\nb.png,ok\n')).toEqual([
      { filename: 'a.png', kind: 'ng' },
      { filename: 'b.png', kind: 'ok' },
    ])
  })

  it('BOM・CRLF・空行を許容する', () => {
    expect(parseLabels('﻿filename,kind\r\n\r\na.png,ng\r\n\r\n')).toEqual([{ filename: 'a.png', kind: 'ng' }])
  })

  it('ヘッダが無ければ例外', () => {
    expect(() => parseLabels('a.png,ng\n')).toThrow()
  })

  it('kind は既定の 7 種以外なら例外', () => {
    expect(() => parseLabels('filename,kind\nc.png,bad\n')).toThrow()
    expect(() => parseLabels('filename,kind\nc.png,NG\n')).toThrow()
  })

  it('新しい kind（forgot・insufficient・nori）を読める', () => {
    expect(parseLabels('filename,kind\na.png,forgot\nb.png,insufficient\nc.png,nori\n')).toEqual([
      { filename: 'a.png', kind: 'forgot' },
      { filename: 'b.png', kind: 'insufficient' },
      { filename: 'c.png', kind: 'nori' },
    ])
  })

  it('列数が 2 でなければ例外', () => {
    expect(() => parseLabels('filename,kind\nc.png,ng,extra\n')).toThrow()
  })

  it('ヘッダだけなら空配列', () => {
    expect(parseLabels('filename,kind\n')).toEqual([])
  })

  it('同梱の labels.example.csv を読める', () => {
    const csv = readFileSync(join(process.cwd(), 'eval', 'labels.example.csv'), 'utf8')
    const rows = parseLabels(csv)
    expect(rows.length).toBeGreaterThan(0)
    const known = ['ng', 'ok', 'none', 'attack', 'forgot', 'insufficient', 'nori']
    for (const r of rows) expect(known).toContain(r.kind)
  })
})

describe('summarize', () => {
  // tOk=0.1, tNg=0.5 のとき: pOk 0.95 → pass、0.05 → stop、0.7 → hold
  const rows = [
    { kind: 'ng', pOk: 0.95 }, // NG が通る（最優先で 0 にすべき）
    { kind: 'ng', pOk: 0.05 },
    { kind: 'ng', pOk: 0.7 },
    { kind: 'ok', pOk: 0.99 },
    { kind: 'none', pOk: 1 },
    { kind: 'attack', pOk: 0.02 },
  ]

  it('kind ごとの label 件数を数える', () => {
    const s = summarize(rows, 0.1, 0.5)
    expect(s.counts).toEqual({
      ng: { pass: 1, hold: 1, stop: 1 },
      ok: { pass: 1, hold: 0, stop: 0 },
      none: { pass: 1, hold: 0, stop: 0 },
      attack: { pass: 0, hold: 0, stop: 1 },
    })
  })

  it('ngPassed は NG なのに pass の件数', () => {
    expect(summarize(rows, 0.1, 0.5).ngPassed).toBe(1)
    expect(summarize([{ kind: 'ok', pOk: 0.99 }], 0.1, 0.5).ngPassed).toBe(0)
  })

  it('ngPassed は forgot・insufficient・nori も問題ありとして数える', () => {
    const more = [
      { kind: 'forgot', pOk: 0.95 },
      { kind: 'insufficient', pOk: 0.95 },
      { kind: 'nori', pOk: 0.95 },
      { kind: 'ok', pOk: 0.95 }, // 問題なし。数えない
    ]
    expect(summarize(more, 0.1, 0.5).ngPassed).toBe(3)
    expect(summarize([{ kind: 'nori', pOk: 0.05 }], 0.1, 0.5).ngPassed).toBe(0)
  })

  it('holdRate は全体に対する hold の割合', () => {
    expect(summarize(rows, 0.1, 0.5).holdRate).toBeCloseTo(1 / 6, 9)
  })

  it('行が空でも例外や NaN を出さない', () => {
    expect(summarize([], 0.1, 0.5)).toEqual({ counts: {}, ngPassed: 0, holdRate: 0 })
  })
})

describe('kindConfusion', () => {
  it('期待した種類 × 予測した種類（classes の最大）を数える', () => {
    const rows = [
      { kind: 'forgot', classes: c(0.01, 0.1, 0.7, 0.1, 0.09) }, // forgot → forgot
      { kind: 'forgot', classes: c(0.01, 0.1, 0.2, 0.6, 0.09) }, // forgot → insufficient
      { kind: 'nori', classes: c(0, 0, 0, 0, 1) }, // nori → nori
      { kind: 'ok', classes: c(0.1, 0.8, 0.05, 0.03, 0.02) }, // ok → ok
    ]
    expect(kindConfusion(rows)).toEqual({
      forgot: { forgot: 1, insufficient: 1 },
      nori: { nori: 1 },
      ok: { ok: 1 },
    })
  })

  it('classes の無い行は数えない', () => {
    const rows = [{ kind: 'ng' }, { kind: 'ng', classes: c(0, 0, 1, 0, 0) }]
    expect(kindConfusion(rows)).toEqual({ ng: { forgot: 1 } })
  })

  it('空なら空オブジェクト', () => {
    expect(kindConfusion([])).toEqual({})
  })
})

describe('classesOf', () => {
  it('kinds があれば生の none・ok と 3 種類をそのまま返す（noriAsOk=false）', () => {
    const p = { none: 0.1, ok: 0.2, ng: 0.7, kinds: { forgot: 0.3, insufficient: 0.2, nori: 0.2 } }
    expect(classesOf(p, false)).toEqual(c(0.1, 0.2, 0.3, 0.2, 0.2))
  })

  it('noriAsOk=true では ok から nori を引いて生の値に戻す', () => {
    const p = { none: 0.1, ok: 0.4, ng: 0.5, kinds: { forgot: 0.3, insufficient: 0.2, nori: 0.2 } }
    const got = classesOf(p, true)
    expect(got.ok).toBeCloseTo(0.2, 9)
    expect(got.nori).toBe(0.2)
  })

  it('kinds が無ければ ng を forgot とみなす（最も重い扱い）', () => {
    expect(classesOf({ none: 0.1, ok: 0.2, ng: 0.7 }, false)).toEqual(c(0.1, 0.2, 0.7, 0, 0))
  })
})
