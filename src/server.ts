// 統合: 設定 → 判定器 → 判定パイプライン → ゲート → HTTP / MCP。
import { resolve } from 'node:path'
import type { Server } from 'node:http'
import { pathToFileURL } from 'node:url'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { check, checkDetail, scoreImage, type CheckDeps } from './check.ts'
import { assertSafeBind, loadConfig, totalJudgeSlots, type Config } from './config.ts'
import { createGate } from './gate.ts'
import { normalize } from './images.ts'
import { createHttpServer } from './http.ts'
import { renderVariants } from './layers.ts'
import { buildCrops } from './crops.ts'
import { createMcpHandler } from './mcp.ts'
import { Calibrator, assertIncreasingCalibration } from './probability.ts'
import { loadEnvFile } from './env-file.ts'
import { createRecheck } from './recheck.ts'
import { buildJudges } from './vlm.ts'

export interface ServerOverrides {
  log?: (line: string) => void
  /** DETECT=1 のときに必須の切り出し。main() が createDetector と buildCrops で作る。 */
  crops?: CheckDeps['crops']
}

/**
 * 設定から HTTP サーバーを組み立てる（listen は呼び出し側）。ループバック以外でキーが無ければ投げる。
 * DETECT=1 なのに crops がないとき、較正が単調増加でないときも投げる。
 */
export function buildServer(cfg: Config, overrides: ServerOverrides = {}): Server {
  assertSafeBind(cfg)
  const log = overrides.log ?? ((line: string) => console.log(line))
  const cal = Calibrator.load(cfg.calibrationPath)
  if (cfg.detect) {
    if (!overrides.crops) throw new Error('DETECT=1 には切り出し（crops）の組み立てが必要です')
    assertIncreasingCalibration(cal)
    const detectors = [cfg.detectAnime, cfg.detectPhoto].filter(Boolean).length
    log(`前段の検出: 有効（検出器 ${detectors}、分類器${cfg.style ? 'あり' : 'なし'}）`)
  }
  const judges = buildJudges(cfg)

  // 再判定は既定オフ。有効時だけ Pi のチャット（llama-server の OpenAI 互換口）を渡す。
  // 分類用の max_tokens:1 はここでは使わない。crop のツール呼び出し JSON が途中で切れるため。
  // 計画書に無い配線（Pi のチャット経路）。偽 llama-server の e2e（RECHECK=1）で確かめている。
  // 再判定は台の 1 つ目だけを使う（振り分けの対象外。既定オフの機能）
  const primary = cfg.judges[0]!
  const root = primary.urls[0]!
  const recheck = cfg.recheck
    ? createRecheck(cfg, {
        score: async (png, signal) => (await scoreImage(png, judges, cal, signal)).pOk,
        chat: {
          streamFn: (model: unknown, context: unknown, options?: object) =>
            streamSimple(model as never, context as never, {
              ...options,
              apiKey: cfg.vlmApiKey ?? 'none',
            } as never),
          model: {
            id: primary.model,
            name: primary.model,
            api: 'openai-completions',
            provider: 'llama-cpp-local',
            baseUrl: `${root}/v1`,
            reasoning: false,
            input: ['text', 'image'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            // 画像付きの会話と crop の JSON に余裕がある大きさ。出力上限は 1024。
            contextWindow: 32768,
            maxTokens: 1024,
          },
        },
      })
    : undefined

  const gate = createGate(totalJudgeSlots(cfg), cfg.queueTimeoutMs)
  const deps: CheckDeps = {
    renderVariants,
    normalize,
    judges,
    cal,
    recheck,
    log,
    crops: overrides.crops,
  }
  // 判定（数値）と詳細は同じゲート・同じ signal で包む
  const gated =
    <T>(fn: (bytes: Uint8Array, signal: AbortSignal) => Promise<T>) =>
    (bytes: Uint8Array, signal: AbortSignal) =>
      gate.run(
        // Buffer の view を、先頭から始まる独立した Uint8Array にする。
        // layers.ts は data.slice().buffer を使うため、プールの一部を指す Buffer だと誤って読む。
        () => fn(new Uint8Array(bytes), signal),
        signal,
      )
  const gatedCheck = gated((b, s) => check(b, cfg, deps, s))
  const gatedDetail = gated((b, s) => checkDetail(b, cfg, deps, s))

  return createHttpServer(
    cfg,
    { check: gatedCheck, checkDetail: gatedDetail, mcp: createMcpHandler(gatedCheck, cfg, gatedDetail) },
    log,
  )
}

async function main(): Promise<void> {
  const cfg = loadConfig(loadEnvFile())
  // DETECT=0 では detect.ts も ONNX ランタイムも読み込まない
  const crops = cfg.detect
    ? buildCrops(cfg, await (await import('./detect.ts')).createDetector(cfg, process.cwd()))
    : undefined
  const server = buildServer(cfg, { crops })
  await new Promise<void>((ok, ng) => {
    server.once('error', ng)
    server.listen(cfg.port, cfg.bind, () => ok())
  })
  const cors = cfg.corsOrigins === '*' ? '*' : `${cfg.corsOrigins.length} 件`
  console.log(`待受 ${cfg.bind}:${cfg.port} / CORS: ${cors} / 許可 CIDR: ${cfg.allowCidrs.join(', ')}`)

  const stop = () => {
    server.closeAllConnections()
    server.close(() => process.exit(0))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

// 直接実行されたときだけ起動する（テストからの import では起動しない）
const entry = process.argv[1]
if (entry && pathToFileURL(resolve(entry)).href === import.meta.url) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : '起動に失敗しました')
    process.exit(1)
  })
}
