// 評価の純粋な関数（CSV 解析・集計）。実行の本体は run_eval.ts。
import type { ClassProbs, Detail, Label } from '../src/types.ts'
import { label as judgeLabel } from '../src/probability.ts'

export type EvalKind = 'ng' | 'ok' | 'none' | 'attack' | 'forgot' | 'insufficient' | 'nori'

/** 詳細応答の classes（最悪の描画の生の確率）。 */
export type Classes = Detail['classes']

const KINDS: readonly string[] = ['ng', 'ok', 'none', 'attack', 'forgot', 'insufficient', 'nori']
/** 問題ありとして扱う kind（ng は種類が未指定の問題）。 */
const PROBLEM_KINDS: readonly string[] = ['ng', 'forgot', 'insufficient', 'nori']
const HEADER = 'filename,kind'

export function isProblem(kind: string): boolean {
  return PROBLEM_KINDS.includes(kind)
}

/** `filename,kind` の CSV を読む。BOM・CRLF・空行は許容し、他は例外にする。 */
export function parseLabels(csv: string): { filename: string; kind: EvalKind }[] {
  const lines = csv
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (lines[0] !== HEADER) throw new Error(`ラベル CSV の先頭行は ${HEADER} である必要があります`)
  return lines.slice(1).map((line, i) => {
    const cols = line.split(',').map((s) => s.trim())
    const [filename = '', kind = ''] = cols
    if (cols.length !== 2 || filename === '') throw new Error(`ラベル CSV のデータ ${i + 1} 行目の形式が不正です`)
    if (!KINDS.includes(kind)) throw new Error(`ラベル CSV のデータ ${i + 1} 行目の kind が不正です`)
    return { filename, kind: kind as EvalKind }
  })
}

/** kind ごとの label 件数、問題ありなのに pass の件数、全体に対する hold の割合。 */
export function summarize(
  rows: { kind: string; pOk: number }[],
  tOk: number,
  tNg: number,
): { counts: Record<string, Record<Label, number>>; ngPassed: number; holdRate: number } {
  const counts: Record<string, Record<Label, number>> = {}
  let ngPassed = 0
  let holds = 0
  for (const r of rows) {
    const lb = judgeLabel(r.pOk, tOk, tNg)
    const row = (counts[r.kind] ??= { pass: 0, hold: 0, stop: 0 })
    row[lb] += 1
    if (isProblem(r.kind) && lb === 'pass') ngPassed += 1
    if (lb === 'hold') holds += 1
  }
  return { counts, ngPassed, holdRate: rows.length === 0 ? 0 : holds / rows.length }
}

const PREDICTED: readonly (keyof Classes)[] = ['none', 'ok', 'forgot', 'insufficient', 'nori']

/**
 * 期待した kind × 予測した種類（classes の最大）の混同行列。classes の無い行は数えない。
 * 同点は PREDICTED の先頭側を採る。
 */
export function kindConfusion(
  rows: { kind: string; classes?: Classes }[],
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const r of rows) {
    if (!r.classes) continue
    const cl = r.classes
    const predicted = PREDICTED.reduce((best, k) => (cl[k] > cl[best] ? k : best), PREDICTED[0] as keyof Classes)
    const row = (out[r.kind] ??= {})
    row[predicted] = (row[predicted] ?? 0) + 1
  }
  return out
}

/**
 * 判定の確率を、詳細応答と同じ生の classes に直す。
 * noriAsOk のときは ok に nori が足されているので、引いて戻す。kinds が無い（古いフェイク）なら ng を forgot とみなす。
 */
export function classesOf(p: ClassProbs, noriAsOk: boolean): Classes {
  const k = p.kinds
  if (!k) return { none: p.none, ok: p.ok, forgot: p.ng, insufficient: 0, nori: 0 }
  return { none: p.none, ok: noriAsOk ? Math.max(0, p.ok - k.nori) : p.ok, ...k }
}
