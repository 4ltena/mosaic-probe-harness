// 評価 CLI: `npx tsx eval/run_eval.ts --labels <csv> --images <dir> [--write]`
// 画像ごとに最悪の描画を採用して判定し、混同行列・保留率・信頼度・推奨閾値を表示する。
// --write のときだけ calibration.json を書く。推奨閾値はサーバーには渡さない。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.ts'
import { renderVariants } from '../src/layers.ts'
import { normalize } from '../src/images.ts'
import { Calibrator, chooseThresholds, pOk, reliability } from '../src/probability.ts'
import type { ClassProbs } from '../src/types.ts'
import { buildJudge } from '../src/vlm.ts'
import { parseLabels, summarize } from './lib.ts'

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

  const cfg = loadConfig()
  const cal = Calibrator.load(cfg.calibrationPath)
  const { judge } = buildJudge(cfg)
  const labels = parseLabels(readFileSync(labelsPath, 'utf8'))

  // 画像ごとに全描画を判定し、pOk が最小の描画を採用する
  const results: { filename: string; kind: string; probs: ClassProbs; ms: number }[] = []
  for (const { filename, kind } of labels) {
    const t0 = performance.now()
    const data = new Uint8Array(readFileSync(join(imagesDir, filename)))
    const variants = await renderVariants(data, {
      maxRenders: cfg.maxRenders,
      layerPattern: cfg.layerPattern,
      maxPixels: cfg.maxPixels,
      log: (line: string) => console.log(line),
    })
    let worst: ClassProbs | undefined
    let worstP = Infinity
    for (const v of variants) {
      const jpeg = await normalize(v.image, { maxEdge: cfg.maxEdge, maxPixels: cfg.maxPixels })
      const probs = await judge(jpeg)
      const p = pOk(probs, cal)
      if (p < worstP) {
        worstP = p
        worst = probs
      }
    }
    if (!worst) throw new Error(`${filename}: 描画が 0 件でした`)
    results.push({ filename, kind, probs: worst, ms: performance.now() - t0 })
  }

  // ファイル名と確率だけを保存する
  const scored = results.map((r) => ({ filename: r.filename, probs: r.probs, pOk: pOk(r.probs, cal) }))
  writeFileSync(join(evalDir, 'results.jsonl'), scored.map((r) => JSON.stringify(r)).join('\n') + '\n')

  const rows = results.map((r, i) => ({ kind: r.kind, pOk: scored[i]?.pOk ?? 0 }))
  const isOkLike = (k: string) => k === 'ok' || k === 'none'
  const ngPNg = rows.filter((r) => r.kind === 'ng').map((r) => 1 - r.pOk)
  const okPNg = rows.filter((r) => isOkLike(r.kind)).map((r) => 1 - r.pOk)
  const [tOk, tNg] = chooseThresholds(ngPNg, okPNg)
  const s = summarize(rows, tOk, tNg)

  console.log(`\n=== 混同行列（閾値 tOk=${tOk.toFixed(3)} tNg=${tNg.toFixed(3)}） ===`)
  console.log(`NG が pass になった件数: ${s.ngPassed}（最優先・0 が目標）`)
  for (const kind of ['ng', 'ok', 'none', 'attack']) {
    const c = s.counts[kind]
    if (c) console.log(`${kind.padEnd(7)} pass=${c.pass} hold=${c.hold} stop=${c.stop}`)
  }
  console.log(`保留率: ${(s.holdRate * 100).toFixed(1)}%`)

  // 攻撃画像は ECE から外し、結果を個別に出す
  const calRows = rows.filter((r) => r.kind !== 'attack')
  const rel = reliability(
    calRows.map((r) => 1 - r.pOk),
    calRows.map((r) => (r.kind === 'ng' ? 1 : 0)),
  )
  console.log('\n=== 信頼度（NG 確率のビン別） ===')
  for (const b of rel.bins) {
    console.log(`[${b.lo.toFixed(2)}, ${b.hi.toFixed(2)})  n=${b.n}  予測=${b.meanPred.toFixed(3)}  実測=${b.freq.toFixed(3)}`)
  }
  console.log(`ECE: ${rel.ece.toFixed(3)}（目標 0.10 以下）`)

  console.log('\n=== 攻撃画像 ===')
  for (const r of results.filter((x) => x.kind === 'attack')) {
    const p = scored.find((x) => x.filename === r.filename)?.pOk ?? NaN
    console.log(`${r.filename}  p_ok=${p.toFixed(4)}`)
  }

  const medianMs = median(results.map((r) => r.ms))
  console.log(`\n所要時間の中央値: ${(medianMs / 1000).toFixed(1)} 秒/画像`)

  console.log('\n=== docs/eval-log.md 追記用（手で貼る） ===')
  console.log(
    `- 閾値 tOk=${tOk.toFixed(3)} tNg=${tNg.toFixed(3)}: NG pass ${s.ngPassed} 件、保留率 ${(s.holdRate * 100).toFixed(1)}%、ECE ${rel.ece.toFixed(3)}`,
  )

  if (write) {
    // 較正は生の q = ng/(ng+ok) から学習する。y=1 は NG
    const fitRows = results.filter((r) => (r.kind === 'ng' || r.kind === 'ok') && r.probs.ng + r.probs.ok > 0)
    const qs = fitRows.map((r) => r.probs.ng / (r.probs.ng + r.probs.ok))
    const ys = fitRows.map((r) => (r.kind === 'ng' ? 1 : 0))
    const fitted = Calibrator.fit(qs, ys).toJSON()
    writeFileSync(cfg.calibrationPath, JSON.stringify(fitted, null, 2) + '\n')
    console.log(`\ncalibration.json を書きました（a=${fitted.a.toFixed(4)}, b=${fitted.b.toFixed(4)}）`)
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exitCode = 1
})
