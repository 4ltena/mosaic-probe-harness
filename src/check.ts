import type { Config } from './config.ts'
import { CheckError, type ClassProbs, type Detail } from './types.ts'

// 他モジュール（layers.ts / images.ts）と構造的に同じ形。未実装でも型が通るよう、ここに書き下す。
export interface CheckDeps {
  renderVariants: (
    data: Uint8Array,
    opts: { maxRenders: number; layerPattern: string; maxPixels: number; log?: (line: string) => void },
  ) => Promise<{ description: string; image: Uint8Array }[]>
  normalize: (data: Uint8Array, opts: { maxEdge: number; maxPixels: number }) => Promise<Uint8Array>
  judge: (jpeg: Uint8Array, signal?: AbortSignal) => Promise<ClassProbs>
  pOk: (p: ClassProbs) => number
  recheck?: (jpeg: Uint8Array, p: number) => Promise<number>
  log?: (line: string) => void
}

interface Scored {
  q: number
  jpeg: Uint8Array
  probs: ClassProbs
  description: string
}

/** 全描画を判定し、p_ok が最小の描画（再判定後の p を含む）を返す。失敗は CheckError で投げる。 */
async function runCheck(
  data: Uint8Array,
  cfg: Config,
  deps: CheckDeps,
  signal?: AbortSignal,
): Promise<{ p: number; worst: Scored }> {
  try {
    const variants = await deps.renderVariants(data, {
      maxRenders: cfg.maxRenders,
      layerPattern: cfg.layerPattern,
      maxPixels: cfg.maxPixels,
      log: deps.log,
    })
    if (variants.length === 0) throw new CheckError('bad_input', '描画できる画像がありません')

    // 外側の切断と、1 件の失敗の両方で残りを止める
    const ctl = new AbortController()
    const onAbort = () => ctl.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const scores: Scored[] = []
    let next = 0
    // 最初の失敗だけを記録する（残りの worker は abort で止まり、その例外は捨てる）
    let firstErr: { e: unknown } | undefined
    const worker = async (): Promise<void> => {
      try {
        while (next < variants.length) {
          ctl.signal.throwIfAborted()
          const i = next++
          const jpeg = await deps.normalize(variants[i]!.image, { maxEdge: cfg.maxEdge, maxPixels: cfg.maxPixels })
          ctl.signal.throwIfAborted()
          const probs = await deps.judge(jpeg, ctl.signal)
          scores[i] = { q: deps.pOk(probs), jpeg, probs, description: variants[i]!.description }
        }
      } catch (e) {
        firstErr ??= { e }
        ctl.abort(e)
      }
    }
    const limit = Math.max(1, Math.min(variants.length, cfg.vlmBaseUrls.length * cfg.vlmSlotsPerBackend))
    await Promise.all(Array.from({ length: limit }, worker))
    signal?.removeEventListener('abort', onAbort)
    if (firstErr) throw firstErr.e
    signal?.throwIfAborted()

    let worst = scores[0]!
    for (const s of scores) {
      if (s.q < worst.q) worst = s
    }
    let p = worst.q

    // 再判定は既定オフ。範囲内の最悪ケースだけを対象にし、結果は下げるだけ
    if (cfg.recheck && deps.recheck && p >= cfg.recheckLo && p <= cfg.recheckHi) {
      try {
        const r = await deps.recheck(worst.jpeg, p)
        if (Number.isFinite(r)) p = Math.min(p, r)
      } catch {
        deps.log?.('再判定に失敗したため一次判定を採用')
      }
    }
    return { p, worst }
  } catch (e) {
    if (e instanceof CheckError) throw e
    if (signal?.aborted) throw signal.reason
    throw new CheckError('internal', '判定中に内部エラーが起きました')
  }
}

/**
 * 判定の生の確率から詳細の classes を作る。
 * noriAsOk のとき judge は nori を ok に足しているので、ok から nori を引いて生の値に戻す。
 * kinds が無い judge（古いフェイク）は、ng をすべて forgot として扱う（最も重い扱い）。
 */
function classesOf(p: ClassProbs, cfg: Config): Detail['classes'] {
  const k = p.kinds
  if (!k) return { none: p.none, ok: p.ok, forgot: p.ng, insufficient: 0, nori: 0 }
  const ok = cfg.noriAsOk ? Math.max(0, p.ok - k.nori) : p.ok
  return { none: p.none, ok, forgot: k.forgot, insufficient: k.insufficient, nori: k.nori }
}

/**
 * 全描画の判定を行い、p_ok の最小値を返す。失敗は CheckError で投げ、数値は返さない。
 * 同時実行は 台数 × スロット数（上限つきの並列）。1 件でも失敗したら残りを中止する。
 * signal が abort されたら、次の描画に進まず、判定要求も止める。
 */
export async function check(data: Uint8Array, cfg: Config, deps: CheckDeps, signal?: AbortSignal): Promise<number> {
  return (await runCheck(data, cfg, deps, signal)).p
}

/**
 * check と同じ判定を行い、詳細（p_ok・最悪の描画の説明・生の種類確率）を返す。
 * pOk は check の戻りと同じ。render と classes は最悪の描画（再判定で下がっても元の描画）のもの。
 */
export async function checkDetail(
  data: Uint8Array,
  cfg: Config,
  deps: CheckDeps,
  signal?: AbortSignal,
): Promise<Detail> {
  const { p, worst } = await runCheck(data, cfg, deps, signal)
  return { pOk: p, render: worst.description, classes: classesOf(worst.probs, cfg) }
}
