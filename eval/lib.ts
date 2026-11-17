// 評価の純粋な関数（CSV 解析・集計）。実行の本体は run_eval.ts。
import type { Label } from '../src/types.ts'
import { label as judgeLabel } from '../src/probability.ts'

export type EvalKind = 'ng' | 'ok' | 'none' | 'attack'

const KINDS: readonly string[] = ['ng', 'ok', 'none', 'attack']
const HEADER = 'filename,kind'

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

/** kind ごとの label 件数、NG なのに pass の件数、全体に対する hold の割合。 */
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
    if (r.kind === 'ng' && lb === 'pass') ngPassed += 1
    if (lb === 'hold') holds += 1
  }
  return { counts, ngPassed, holdRate: rows.length === 0 ? 0 : holds / rows.length }
}
