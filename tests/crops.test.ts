import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import { defaultConfig } from '../src/config.ts'
import { buildCrops, cropRect } from '../src/crops.ts'
import type { Box, Detector } from '../src/detect.ts'

const box = (x0: number, y0: number, x1: number, y1: number): Box => ({ x0, y0, x1, y1, label: 'penis', score: 0.9 })

describe('cropRect（切り出しの範囲）', () => {
  it('余白: 箱の幅・高さの margin 倍ずつ各辺に広げる', () => {
    expect(cropRect(box(40, 50, 60, 90), 200, 200, 0.5, 1)).toEqual({ left: 30, top: 30, width: 40, height: 80 })
    expect(cropRect(box(40, 50, 60, 90), 200, 200, 0, 1)).toEqual({ left: 40, top: 50, width: 20, height: 40 })
  })

  it('最小の短辺: 中心を保ったまま、各辺を DETECT_MIN_SIDE まで広げる', () => {
    expect(cropRect(box(95, 90, 105, 110), 200, 200, 0, 50)).toEqual({ left: 75, top: 75, width: 50, height: 50 })
    // 長い辺はそのまま
    expect(cropRect(box(95, 20, 105, 180), 200, 200, 0, 50)).toEqual({ left: 75, top: 20, width: 50, height: 160 })
  })

  it('画像の端の箱は、大きさを保ったまま画像の中へずらす', () => {
    expect(cropRect(box(0, 0, 20, 20), 200, 100, 0.5, 1)).toEqual({ left: 0, top: 0, width: 40, height: 40 })
    expect(cropRect(box(190, 90, 200, 100), 200, 100, 0, 50)).toEqual({ left: 150, top: 50, width: 50, height: 50 })
  })

  it('余白で画像を超える箱は、画像の中へずらし、画像より大きければ画像の大きさにする', () => {
    expect(cropRect(box(180, 10, 200, 30), 200, 100, 1, 1)).toEqual({ left: 140, top: 0, width: 60, height: 60 })
    expect(cropRect(box(10, 10, 190, 90), 200, 100, 0.5, 1)).toEqual({ left: 0, top: 0, width: 200, height: 100 })
  })

  it('幅や高さが 0 の箱でも、画像の中の 1 px 以上の範囲になる', () => {
    expect(cropRect(box(200, 0, 200, 10), 200, 100, 0, 1)).toEqual({ left: 199, top: 0, width: 1, height: 10 })
    expect(cropRect(box(200, 100, 200, 100), 200, 100, 0.5, 1)).toEqual({ left: 199, top: 99, width: 1, height: 1 })
    expect(cropRect(box(0, 50, 0, 50), 200, 100, 0.5, 32)).toEqual({ left: 0, top: 34, width: 32, height: 32 })
  })
})

describe('buildCrops', () => {
  // 左上 0〜10 だけ赤、ほかは白の 100×50
  const png = async () => {
    const raw = Buffer.alloc(100 * 50 * 3, 255)
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) raw.fill(0, (y * 100 + x) * 3 + 1, (y * 100 + x) * 3 + 3)
    return new Uint8Array(await sharp(raw, { raw: { width: 100, height: 50, channels: 3 } }).png().toBuffer())
  }
  const cfg = defaultConfig({ detect: true, detectMargin: 0, detectMinSide: 1 })

  it('検出器の並びのまま、拡大も縮小もせず PNG で切り出す。範囲が全体と同じ箱は除く', async () => {
    const signal = new AbortController().signal
    const detector = vi.fn<Detector>(async () => [box(50, 0, 100, 50), box(0, 0, 100, 50), box(0, 0, 10, 10), box(100, 0, 100, 10)])
    const src = await png()
    const out = await buildCrops(cfg, detector)(src, signal)
    expect(detector).toHaveBeenCalledWith(src, signal)
    expect(out).toHaveLength(3)
    const metas = await Promise.all(out.map((b) => sharp(b).metadata()))
    expect(metas.map((m) => [m.format, m.width, m.height])).toEqual([['png', 50, 50], ['png', 10, 10], ['png', 1, 10]])
    // 2 件目は左上の赤い 10×10 そのもの
    const { data } = await sharp(out[1]!).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    expect([...data.subarray(0, 3)]).toEqual([255, 0, 0])
    expect(data.length).toBe(10 * 10 * 3)
    expect(data.every((v, i) => v === (i % 3 === 0 ? 255 : 0))).toBe(true)
  })

  it('寸法を読めない画像（幅 0）は、切り出さずに internal で止まる', async () => {
    const spy = vi.spyOn(Object.getPrototypeOf(sharp()), 'metadata').mockResolvedValueOnce({ width: 0, height: 50 })
    try {
      await expect(buildCrops(cfg, async () => [box(0, 0, 10, 10)])(await png(), new AbortController().signal)).rejects.toMatchObject({ kind: 'internal' })
    } finally {
      spy.mockRestore()
    }
  })

  it('箱がなければ空', async () => {
    expect(await buildCrops(cfg, async () => [])(await png(), new AbortController().signal)).toEqual([])
  })
})
