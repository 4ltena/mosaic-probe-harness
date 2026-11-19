import { totalJudgeSlots, type Config } from './config.ts'
import type { RenderOptions, Variant } from './layers.ts'
import { aggregate, judge4, type Calibrator } from './probability.ts'
import { CheckError, type Detail, type Judge } from './types.ts'

export interface CheckDeps {
  renderVariants: (data: Uint8Array, opts: RenderOptions) => Promise<Variant[]>
  normalize: (data: Uint8Array, opts: { maxEdge: number; maxPixels: number }) => Promise<Uint8Array>
  judges: readonly Judge[]
  cal?: Calibrator
  recheck?: (png: Uint8Array, p: number, signal?: AbortSignal) => Promise<number>
  log?: (line: string) => void
}

/** 同じ描画について全モデルの確率を集め、統合後に式を適用する。 */
export async function scoreImage(
  png: Uint8Array,
  judges: readonly Judge[],
  cal?: Calibrator,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const models = await Promise.all(judges.map(async (judge) => ({
    name: judge.name, weight: judge.weight, probs: await judge.judge(png, signal),
  })))
  return { ...judge4(aggregate(models), cal), perModel: Object.fromEntries(models.map((m) => [m.name, m.probs])) }
}

interface Scored {
  index: number
  png: Uint8Array
  detail: Detail
  q: number
}

/** 全描画を判定し、最小の p_ok とその描画の較正前 q を返す。 */
export async function checkResult(
  data: Uint8Array,
  cfg: Config,
  deps: CheckDeps,
  signal?: AbortSignal,
): Promise<{ detail: Detail; q: number }> {
  const ctl = new AbortController()
  const workSignal = signal ? AbortSignal.any([ctl.signal, signal]) : ctl.signal
  try {
    workSignal.throwIfAborted()
    const variants = await deps.renderVariants(data, {
      maxRenders: cfg.maxRenders,
      maxFrames: cfg.maxFrames,
      maxAnimSeconds: cfg.maxAnimSeconds,
      layerPattern: cfg.layerPattern,
      maxPixels: cfg.maxPixels,
    })
    if (variants.length === 0) throw new CheckError('bad_input', '描画できる画像がありません')

    let worst: Scored | undefined
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < variants.length) {
        workSignal.throwIfAborted()
        const index = next++
        const variant = variants[index]!
        const rendered = await variant.render()
        workSignal.throwIfAborted()
        const png = await deps.normalize(rendered, { maxEdge: cfg.maxEdge, maxPixels: cfg.maxPixels })
        const { pOk, judgment, confidence, classes, perModel, q } =
          await scoreImage(png, deps.judges, deps.cal, workSignal)
        if (!worst || pOk < worst.detail.pOk || (pOk === worst.detail.pOk && index < worst.index)) {
          worst = { q, index, png, detail: { pOk, judgment, confidence, classes, perModel, render: variant.description } }
        }
      }
    }
    // 描画は必要になってから生成する。モデルごとの共有プールが全リクエストの同時実行数を制限する。
    const limit = Math.max(1, Math.min(variants.length, totalJudgeSlots(cfg)))
    await Promise.all(Array.from({ length: limit }, worker))
    workSignal.throwIfAborted()
    const { detail, q, png } = worst!
    if (cfg.recheck && deps.recheck && detail.pOk >= cfg.recheckLo && detail.pOk <= cfg.recheckHi) {
      try {
        const value = await deps.recheck(png, detail.pOk, workSignal)
        if (Number.isFinite(value) && value >= 0) detail.pOk = Math.min(detail.pOk, value)
      } catch (e) {
        workSignal.throwIfAborted()
        if (e instanceof CheckError && e.kind === 'vlm') throw e
        deps.log?.('再判定に失敗したため一次判定を採用')
      }
    }
    workSignal.throwIfAborted()
    return { detail, q }
  } catch (e) {
    ctl.abort(e)
    if (signal?.aborted) throw signal.reason
    if (e instanceof CheckError) throw e
    throw new CheckError('internal', '判定中に内部エラーが起きました')
  }
}

/** 通常応答は p_ok だけを返す。 */
export async function check(data: Uint8Array, cfg: Config, deps: CheckDeps, signal?: AbortSignal): Promise<number> {
  return (await checkResult(data, cfg, deps, signal)).detail.pOk
}

export async function checkDetail(data: Uint8Array, cfg: Config, deps: CheckDeps, signal?: AbortSignal): Promise<Detail> {
  return (await checkResult(data, cfg, deps, signal)).detail
}
