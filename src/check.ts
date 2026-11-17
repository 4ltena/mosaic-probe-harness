import type { Config } from './config.ts'
import { CheckError, type ClassProbs } from './types.ts'

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

/**
 * 全描画の判定を行い、p_ok の最小値を返す。失敗は CheckError で投げ、数値は返さない。
 * 同時実行は 台数 × スロット数（上限つきの並列）。1 件でも失敗したら残りを中止する。
 * signal が abort されたら、次の描画に進まず、判定要求も止める。
 */
export async function check(data: Uint8Array, cfg: Config, deps: CheckDeps, signal?: AbortSignal): Promise<number> {
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
    const scores: { q: number; jpeg: Uint8Array }[] = []
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
          scores[i] = { q: deps.pOk(await deps.judge(jpeg, ctl.signal)), jpeg }
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

    let p = Infinity
    let worstJpeg: Uint8Array = new Uint8Array(0)
    for (const s of scores) {
      if (s.q < p) {
        p = s.q
        worstJpeg = s.jpeg
      }
    }

    // 再判定は既定オフ。範囲内の最悪ケースだけを対象にし、結果は下げるだけ
    if (cfg.recheck && deps.recheck && p >= cfg.recheckLo && p <= cfg.recheckHi) {
      try {
        const r = await deps.recheck(worstJpeg, p)
        if (Number.isFinite(r)) p = Math.min(p, r)
      } catch {
        deps.log?.('再判定に失敗したため一次判定を採用')
      }
    }
    return p
  } catch (e) {
    if (e instanceof CheckError) throw e
    if (signal?.aborted) throw signal.reason
    throw new CheckError('internal', '判定中に内部エラーが起きました')
  }
}
