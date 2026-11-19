import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { kindConfusion, parseLabels, summarize } from '../eval/lib.ts'

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

  it('kind は既定の 6 種以外なら例外', () => {
    expect(() => parseLabels('filename,kind\nc.png,bad\n')).toThrow()
    expect(() => parseLabels('filename,kind\nc.png,NG\n')).toThrow()
    expect(() => parseLabels('filename,kind\nc.png,insufficient\n')).toThrow()
  })

  it('新しい kind（forgot・nori）を読める', () => {
    expect(parseLabels('filename,kind\na.png,forgot\nc.png,nori\n')).toEqual([
      { filename: 'a.png', kind: 'forgot' },
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
    const known = ['ng', 'ok', 'none', 'attack', 'forgot', 'nori']
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

  it('ngPassed は forgot・nori も問題ありとして数える', () => {
    const more = [
      { kind: 'forgot', pOk: 0.95 },
      { kind: 'nori', pOk: 0.95 },
      { kind: 'ok', pOk: 0.95 }, // 問題なし。数えない
    ]
    expect(summarize(more, 0.1, 0.5).ngPassed).toBe(2)
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
  it('期待した種類 × 最悪の描画の総合判断を数える', () => {
    expect(kindConfusion([
      { kind: 'forgot', judgment: 'forgot' },
      { kind: 'forgot', judgment: 'nori' },
      { kind: 'none', judgment: 'ok' },
      { kind: 'ok', judgment: 'ok' },
    ])).toEqual({
      forgot: { forgot: 1, nori: 1 },
      none: { ok: 1 },
      ok: { ok: 1 },
    })
  })

  it('空なら空オブジェクト', () => {
    expect(kindConfusion([])).toEqual({})
  })
})
