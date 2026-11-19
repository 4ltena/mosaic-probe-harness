// 評価 CLI: `npx tsx eval/run_eval.ts --labels <csv> --images <dir> [--write]`
// 画像ごとに最悪の描画を採用して判定し、混同行列・保留率・信頼度・推奨閾値を表示する。
// --write のときだけ calibration.json を書く。推奨閾値はサーバーには渡さない。
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadConfig } from '../src/config.ts'
import { loadEnvFile } from '../src/env-file.ts'
import { checkResult, type CheckDeps } from '../src/check.ts'
import { chooseThresholds, reliability } from '../src/probability.ts'
import { EVAL_KINDS, buildEvalDeps, fitCalibration, isProblem, kindConfusion, parseLabels, summarize } from './lib.ts'

const evalDir = fileURLToPath(new URL('.', import.meta.url))

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const labelsPath = arg(argv, '--labels')
  const imagesDir = arg(argv, '--images')
  const write = argv.includes('--write')
  if (!labelsPath || !imagesDir) {
    console.error('使い方: npx tsx eval/run_eval.ts --labels <csv> --images <dir> [--write]')
    process.exitCode = 2
    return
  }

  const cfg = loadConfig(loadEnvFile())
  // サーバーと同じ検出器と切り出し。DETECT=0 では crops.ts も detect.ts も ONNX ランタイムも読み込まない
  let crops: CheckDeps['crops']
  if (cfg.detect) {
    const [{ createDetector }, { buildCrops }] = await Promise.all([import('../src/detect.ts'), import('../src/crops.ts')])
    crops = buildCrops(cfg, await createDetector(cfg, process.cwd()))
  }
  const deps = buildEvalDeps(cfg, crops)
  const labels = parseLabels(readFileSync(labelsPath, 'utf8'))

  const results = []
  for (const { filename, kind } of labels) {
    const t0 = performance.now()
    const data = new Uint8Array(readFileSync(join(imagesDir, filename)))
    const { detail, q } = await checkResult(data, cfg, deps)
    results.push({ filename, kind, q, detail, ms: performance.now() - t0 })
  }

  const scored = results.map(({ filename, kind, q, detail }) => ({
    filename, kind, q, p_ok: detail.pOk, judgment: detail.judgment, render: detail.render,
    classes: detail.classes, per_model: detail.perModel,
  }))
  writeFileSync(join(evalDir, 'results.jsonl'), scored.map((r) => JSON.stringify(r)).join('\n') + '\n')

  const rows = results.map(({ kind, detail }) => ({ kind, pOk: detail.pOk, judgment: detail.judgment }))
  const isOkLike = (k: string) => k === 'ok' || k === 'none'
  const ngPNg = rows.filter((r) => isProblem(r.kind)).map((r) => 1 - r.pOk)
  const okPNg = rows.filter((r) => isOkLike(r.kind)).map((r) => 1 - r.pOk)
  const [tOk, tNg] = chooseThresholds(ngPNg, okPNg)
  const s = summarize(rows, tOk, tNg)

  console.log(`\n=== 混同行列（閾値 tOk=${tOk.toFixed(3)} tNg=${tNg.toFixed(3)}） ===`)
  console.log(`問題ありが pass になった件数: ${s.ngPassed}（最優先・0 が目標）`)
  for (const kind of EVAL_KINDS) {
    const c = s.counts[kind]
    if (c) console.log(`${kind.padEnd(12)} pass=${c.pass} hold=${c.hold} stop=${c.stop}`)
  }
  console.log(`保留率: ${(s.holdRate * 100).toFixed(1)}%`)

  // 種類別の混同行列（行: 期待した kind / 列: 最悪の描画の総合判断）
  const cols = ['ok', 'forgot', 'nori']
  const conf = kindConfusion(rows)
  console.log('\n=== 種類別の混同行列（行: 期待 / 列: 予測） ===')
  console.log(['expected'.padEnd(14), ...cols.map((c) => c.padStart(12))].join(''))
  for (const [kind, row] of Object.entries(conf)) {
    console.log([kind.padEnd(14), ...cols.map((c) => String(row[c] ?? 0).padStart(12))].join(''))
  }

  // 攻撃画像は ECE から外し、結果を個別に出す
  const calRows = rows.filter((r) => r.kind !== 'attack')
  const rel = reliability(
    calRows.map((r) => 1 - r.pOk),
    calRows.map((r) => (isProblem(r.kind) ? 1 : 0)),
  )
  console.log('\n=== 信頼度（NG 確率のビン別） ===')
  for (const b of rel.bins) {
    console.log(`[${b.lo.toFixed(2)}, ${b.hi.toFixed(2)})  n=${b.n}  予測=${b.meanPred.toFixed(3)}  実測=${b.freq.toFixed(3)}`)
  }
  console.log(`ECE: ${rel.ece.toFixed(3)}（目標 0.10 以下）`)

  console.log('\n=== 攻撃画像 ===')
  for (const r of results.filter((x) => x.kind === 'attack')) {
    const p = r.detail.pOk
    console.log(`${r.filename}  p_ok=${p.toFixed(4)}`)
  }

  const medianMs = median(results.map((r) => r.ms))
  console.log(`\n所要時間の中央値: ${(medianMs / 1000).toFixed(1)} 秒/画像`)

  console.log('\n=== docs/eval-log.md 追記用（手で貼る） ===')
  console.log(
    `- 閾値 tOk=${tOk.toFixed(3)} tNg=${tNg.toFixed(3)}: NG pass ${s.ngPassed} 件、保留率 ${(s.holdRate * 100).toFixed(1)}%、ECE ${rel.ece.toFixed(3)}`,
  )

  if (write) {
    // 統合後・較正前の q から学習する。y=1 は問題あり。
    const fitRows = results.filter((r) => isProblem(r.kind) || isOkLike(r.kind))
    const qs = fitRows.map((r) => r.q)
    const ys = fitRows.map((r) => (isProblem(r.kind) ? 1 : 0))
    const fitted = fitCalibration(cfg, qs, ys).toJSON()
    writeFileSync(cfg.calibrationPath, JSON.stringify(fitted, null, 2) + '\n')
    console.log(`\ncalibration.json を書きました（a=${fitted.a.toFixed(4)}, b=${fitted.b.toFixed(4)}）`)
  }
}

// 直接実行されたときだけ動かす（テストからの import では動かさない。src/server.ts と同じ判定）
const entry = process.argv[1]
if (entry && pathToFileURL(resolve(entry)).href === import.meta.url) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  })
}
