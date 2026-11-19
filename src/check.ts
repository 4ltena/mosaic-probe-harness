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
  /**
   * DETECT=1 のときの切り出し（検出の並び順、DETECT_MAX_CROPS 件以下）。server.ts と eval が src/crops.ts の buildCrops で作る。
   * cfg.detect が真のときだけ呼ぶ。ここでは crops.ts も detect.ts も import しない。
   */
  crops?: (png: Uint8Array, signal: AbortSignal) => Promise<Uint8Array[]>
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
  /** 候補の番号。全体は 0、切り出し k は k。 */
  cand: number
  png: Uint8Array
  detail: Detail
  q: number
}

/** 順位 (p_ok の昇順, 描画の番号, 候補の番号) の辞書順で、a が b より悪い（先に来る）か。 */
const worse = (a: Scored, b: Scored | undefined): boolean =>
  !b || a.detail.pOk < b.detail.pOk ||
  (a.detail.pOk === b.detail.pOk && (a.index < b.index || (a.index === b.index && a.cand < b.cand)))

async function score(deps: CheckDeps, png: Uint8Array, index: number, cand: number, render: string, signal: AbortSignal) {
  const { pOk, judgment, confidence, classes, perModel, q } = await scoreImage(png, deps.judges, deps.cal, signal)
  return { index, cand, png, q, detail: { pOk, judgment, confidence, classes, perModel, render } } satisfies Scored
}

/**
 * 全描画を判定し、最小の p_ok とその候補の較正前 q を返す。
 * DETECT=1 なら、描画ごとに切り出しも同じ worker の中で 1 件ずつ判定する。再判定は全体の最悪の描画だけに動かし、
 * 最後にその結果と切り出しの最悪を同じ順位で比べる（最終の p_ok は DETECT=0 の値以下）。
 */
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

    const crops = cfg.detect ? deps.crops : undefined
    // 全体の描画の最悪（再判定の対象）と、切り出しの最悪を分けて持つ
    let worst: Scored | undefined
    let worstCrop: Scored | undefined
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < variants.length) {
        workSignal.throwIfAborted()
        const index = next++
        const variant = variants[index]!
        const rendered = await variant.render()
        workSignal.throwIfAborted()
        const png = await deps.normalize(rendered, { maxEdge: cfg.maxEdge, maxPixels: cfg.maxPixels })
        const full = await score(deps, png, index, 0, variant.description, workSignal)
        if (worse(full, worst)) worst = full
        if (!crops) continue
        for (const [i, part] of (await crops(png, workSignal)).entries()) {
          const c = await score(deps, part, index, i + 1, `${variant.description}の切り出し ${i + 1}`, workSignal)
          if (worse(c, worstCrop)) worstCrop = c
        }
      }
    }
    // 描画は必要になってから生成する。モデルごとの共有プールが全リクエストの同時実行数を制限する。
    const limit = Math.max(1, Math.min(variants.length, totalJudgeSlots(cfg)))
    await Promise.all(Array.from({ length: limit }, worker))
    workSignal.throwIfAborted()
    const { detail, png } = worst!
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
    // 切り出しは再判定に渡さない。再判定のあとの全体と比べて、悪い方を採る
    const pick = worstCrop && worse(worstCrop, worst) ? worstCrop : worst!
    return { detail: pick.detail, q: pick.q }
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
