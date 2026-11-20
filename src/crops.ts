// DETECT=1 のときの切り出し。検出器の箱から範囲を決め、拡大も縮小もせず PNG で切り出す。
// detect.ts は型だけを使う（DETECT=0 では ONNX の部品を読み込まない）。
import sharp from 'sharp'
import type { CheckDeps } from './check.ts'
import type { Config } from './config.ts'
import type { Box, Detector } from './detect.ts'
import { CheckError } from './types.ts'

/** 1 軸ぶん。区間 [lo, hi] を長さの margin 倍ずつ両側に広げ、min 未満なら中心を保って min にし、[0, size] の中へずらして収める。 */
function span(lo: number, hi: number, margin: number, min: number, size: number): [number, number] {
  const len = Math.min(size, Math.max(min, Math.ceil((hi - lo) * (1 + 2 * margin))))
  const start = Math.min(Math.max(Math.round((lo + hi - len) / 2), 0), size - len)
  return [start, len]
}

/** 箱から切り出す範囲（画像の中、各辺 1 px 以上）。幅や高さが 0 の箱でも有効な範囲になる。 */
export function cropRect(box: Box, w: number, h: number, margin: number, minSide: number) {
  const [left, width] = span(box.x0, box.x1, margin, minSide, w)
  const [top, height] = span(box.y0, box.y1, margin, minSide, h)
  return { left, top, width, height }
}

/**
 * CheckDeps.crops の形の関数を返す。検出器の並びを保ち、範囲が描画全体と同じものは切り出さない。
 * found には、切り出さなかった箱も含めて検出器の箱をすべて入れる。
 */
export function buildCrops(cfg: Config, detector: Detector): NonNullable<CheckDeps['crops']> {
  return async (png, signal) => {
    const { style, boxes } = await detector(png, signal)
    const { width: w, height: h } = await sharp(png).metadata()
    if (!w || !h) throw new CheckError('internal', '画像の寸法を読み取れません')
    const parts: Uint8Array[] = []
    for (const box of boxes) {
      const r = cropRect(box, w, h, cfg.detectMargin, cfg.detectMinSide)
      if (r.width === w && r.height === h) continue
      parts.push(new Uint8Array(await sharp(png).extract(r).png({ palette: false }).toBuffer()))
    }
    return { parts, found: { style, width: w, height: h, boxes } }
  }
}
