import { writePsd, type Layer } from 'ag-psd'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_LAYER_PATTERN } from '../src/config.ts'
import { renderVariants, type RenderOptions } from '../src/layers.ts'
import { CheckError } from '../src/types.ts'

const W = 4
const H = 4
const RED = [255, 0, 0, 255]
const WHITE = [255, 255, 255, 255]

const solid = (color: number[]) => {
  const data = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) data.set(color, i * 4)
  return { width: W, height: H, data }
}
const layer = (name: string, color: number[], extra: Partial<Layer> = {}): Layer => ({
  name,
  left: 0,
  top: 0,
  imageData: solid(color),
  ...extra,
})
// comp は ag-psd が書く合成画像（Photoshop の合成に相当）。省くと黒になるので、見えているとおりを確かめる時は渡す。
const psdBytes = (children: Layer[], comp?: number[]): Uint8Array =>
  new Uint8Array(writePsd({ width: W, height: H, children, ...(comp ? { imageData: solid(comp) } : {}) }))

const opts = (over: Partial<RenderOptions> = {}): RenderOptions => ({
  maxRenders: 8,
  layerPattern: DEFAULT_LAYER_PATTERN,
  maxPixels: 100_000_000,
  ...over,
})

/** 指定座標の RGB */
async function pixelAt(png: Uint8Array, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  const i = (y * info.width + x) * info.channels
  return [...data.subarray(i, i + 3)]
}
/** 中心画素の RGB */
const centerPixel = (png: Uint8Array): Promise<number[]> => pixelAt(png, Math.floor(W / 2), Math.floor(H / 2))
const centers = (images: { image: Uint8Array }[]) => Promise.all(images.map((v) => centerPixel(v.image)))
/** 最も強いチャンネルの番号（0=R, 1=G, 2=B）。圧縮の誤差を許すための比較。 */
const dominant = (px: number[]): number => px.indexOf(Math.max(...px))
const find = <T extends { description: string }>(vs: T[], part: string): T => {
  const v = vs.find((x) => x.description.includes(part))
  if (!v) throw new Error(`variant not found: ${part}`)
  return v
}
const solidPng = (color: string) => sharp({ create: { width: W, height: H, channels: 3, background: color } }).png().toBuffer()

describe('renderVariants: PSD', () => {
  it('見えているとおりの合成では上のレイヤー（白）が出る', async () => {
    const vs = await renderVariants(psdBytes([layer('背景', RED), layer('モザイク', WHITE)], WHITE), opts())
    expect(await centerPixel(vs[0]!.image)).toEqual([255, 255, 255])
  })

  it('非表示のモザイク層は「非表示も表示」で現れる', async () => {
    const vs = await renderVariants(psdBytes([layer('背景', RED), layer('モザイク', WHITE, { hidden: true })], RED), opts())
    expect(await centerPixel(vs[0]!.image)).toEqual([255, 0, 0])
    expect(await centerPixel(find(vs, '非表示レイヤーも表示').image)).toEqual([255, 255, 255])
  })

  it('モザイク名のレイヤーを非表示にした変種では下（赤）が出る', async () => {
    const vs = await renderVariants(psdBytes([layer('背景', RED), layer('モザイク', WHITE)], WHITE), opts())
    expect(await centerPixel(find(vs, 'モザイク名').image)).toEqual([255, 0, 0])
  })

  it('名前を変えたモザイク層も「1 枚ずつ外す」変種で現れる', async () => {
    const vs = await renderVariants(psdBytes([layer('背景', RED), layer('レイヤー 3', WHITE)], WHITE), opts())
    const colors = await centers(vs)
    expect(colors[0]).toEqual([255, 255, 255])
    expect(colors).toContainEqual([255, 0, 0])
  })

  it('グループ内のモザイク層も名前で非表示にできる', async () => {
    const group: Layer = { name: 'グループ', children: [layer('モザイク', WHITE)] }
    const vs = await renderVariants(psdBytes([layer('背景', RED), group], WHITE), opts())
    expect(await centerPixel(vs[0]!.image)).toEqual([255, 255, 255])
    expect(await centerPixel(find(vs, 'モザイク名').image)).toEqual([255, 0, 0])
  })

  it('不透明度を反映する', async () => {
    const vs = await renderVariants(psdBytes([layer('背景', RED), layer('モザイク', WHITE, { opacity: 0.5 })]), opts())
    const [r, g, b] = await centerPixel(find(vs, '非表示レイヤーも表示').image)
    expect(r).toBe(255)
    expect(g).toBeGreaterThanOrEqual(126)
    expect(g).toBeLessThanOrEqual(130)
    expect(b).toBeGreaterThanOrEqual(126)
    expect(b).toBeLessThanOrEqual(130)
  })

  it('レイヤーマスクで隠れた部分は下（赤）が出る', async () => {
    const maskData = new Uint8ClampedArray(W * H * 4) // すべて 0 = 隠す
    for (let i = 0; i < W * H; i++) maskData[i * 4 + 3] = 255
    const masked = layer('モザイク', WHITE, {
      mask: { left: 0, top: 0, right: W, bottom: H, imageData: { width: W, height: H, data: maskData } },
    })
    const vs = await renderVariants(psdBytes([layer('背景', RED), masked]), opts())
    expect(await centerPixel(find(vs, '非表示レイヤーも表示').image)).toEqual([255, 0, 0])
  })

  it('マスクの R=255 は表示、半分だけ 255 なら右半分だけ白が出る（R チャンネルを読む）', async () => {
    const maskData = new Uint8ClampedArray(W * H * 4)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        maskData.set([x >= 2 ? 255 : 0, 0, 0, 255], (y * W + x) * 4) // 右半分だけ R=255（表示）
      }
    }
    const masked = layer('モザイク', WHITE, {
      mask: { left: 0, top: 0, right: W, bottom: H, imageData: { width: W, height: H, data: maskData } },
    })
    const vs = await renderVariants(psdBytes([layer('背景', RED), masked]), opts())
    const shown = find(vs, '非表示レイヤーも表示').image
    expect(await pixelAt(shown, 3, 2)).toEqual([255, 255, 255]) // 右: 表示
    expect(await pixelAt(shown, 0, 2)).toEqual([255, 0, 0]) // 左: 隠す
  })

  it('マスクの画素データが無く defaultColor=0 のレイヤーは隠れる', async () => {
    const masked = layer('モザイク', WHITE, { mask: { left: 0, top: 0, right: W, bottom: H, defaultColor: 0 } })
    const vs = await renderVariants(psdBytes([layer('背景', RED), masked]), opts())
    expect(await centerPixel(find(vs, '非表示レイヤーも表示').image)).toEqual([255, 0, 0])
  })

  it('レイヤーが 10 枚で maxRenders=4 なら 4 件で、切り捨て件数をログに出す', async () => {
    const children = Array.from({ length: 10 }, (_, i) => layer(`L${i + 1}`, WHITE))
    const log = vi.fn()
    const vs = await renderVariants(psdBytes(children), opts({ maxRenders: 4, log }))
    expect(vs).toHaveLength(4)
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/省略 8 件/))
  })

  it('モザイク名のレイヤーが無ければ「モザイク名を非表示」の変種を作らない', async () => {
    const vs = await renderVariants(psdBytes([layer('背景', RED), layer('レイヤー 3', WHITE)], WHITE), opts())
    expect(vs.some((v) => v.description.includes('モザイク名'))).toBe(false)
  })

  it('画素数が上限を超える PSD は bad_input（展開前にヘッダで判定）', async () => {
    await expect(renderVariants(psdBytes([layer('背景', RED)]), opts({ maxPixels: W * H - 1 }))).rejects.toMatchObject({
      kind: 'bad_input',
    })
  })

  it('キャンバス内でもレイヤーが上限を超えるなら bad_input（ag-psd の確保前に止まる）', async () => {
    // キャンバスは 4x4 で上限内。100x100 の 1 枚だけが上限 100 画素を超える。
    const big: Layer = { name: '大', left: 0, top: 0, imageData: { width: 100, height: 100, data: new Uint8ClampedArray(100 * 100 * 4).fill(255) } }
    await expect(renderVariants(psdBytes([big]), opts({ maxPixels: 100 }))).rejects.toMatchObject({ kind: 'bad_input' })
  })

  it('レイヤー名パターンが不正なら internal（bad_input にしない）', async () => {
    const err = await renderVariants(psdBytes([layer('背景', RED)]), opts({ layerPattern: '(' })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CheckError)
    expect((err as CheckError).kind).toBe('internal')
  })

  it('壊れた PSD は bad_input', async () => {
    const bytes = psdBytes([layer('背景', RED)]).slice(0, 40)
    await expect(renderVariants(bytes, opts())).rejects.toMatchObject({ kind: 'bad_input' })
  })

  it('PSB（バージョン 2）は unsupported', async () => {
    const bytes = new Uint8Array(40)
    bytes.set([0x38, 0x42, 0x50, 0x53, 0x00, 0x02])
    const err = await renderVariants(bytes, opts()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CheckError)
    expect((err as CheckError).kind).toBe('unsupported')
  })

  it.each([16, 32])('%i ビット PSD は描画せず unsupported（数値を返さない）', async (depth) => {
    // ヘッダのビット深度（オフセット 22、BE16）だけを書き換える。8bit 以外は画素を読まずに拒否する。
    const bytes = psdBytes([layer('背景', RED)])
    new DataView(bytes.buffer).setUint16(22, depth)
    const err = await renderVariants(bytes, opts()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CheckError)
    expect((err as CheckError).kind).toBe('unsupported')
  })
})

describe('renderVariants: ラスター', () => {
  it('PNG は 1 件', async () => {
    const png = await sharp({ create: { width: W, height: H, channels: 3, background: '#f00' } }).png().toBuffer()
    const vs = await renderVariants(new Uint8Array(png), opts())
    expect(vs).toHaveLength(1)
    expect(await centerPixel(vs[0]!.image)).toEqual([255, 0, 0])
  })

  it('アニメ GIF はページごとに 1 件（赤・緑・青が別々に出る）、上限も同じく効く', async () => {
    const gif = await sharp([await solidPng('#f00'), await solidPng('#0f0'), await solidPng('#00f')], {
      join: { animated: true },
    })
      .gif()
      .toBuffer()
    const all = await renderVariants(new Uint8Array(gif), opts())
    expect(all).toHaveLength(3)
    expect((await centers(all)).map(dominant)).toEqual([0, 1, 2])
    const log = vi.fn()
    const capped = await renderVariants(new Uint8Array(gif), opts({ maxRenders: 2, log }))
    expect(capped).toHaveLength(2)
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/省略 1 件/))
  })

  it('複数ページ TIFF はページごとに 1 件（ページごとに色が違う）、上限も同じく効く', async () => {
    const tiff = await sharp([await solidPng('#f00'), await solidPng('#0f0')], { join: { animated: true } })
      .tiff()
      .toBuffer()
    const all = await renderVariants(new Uint8Array(tiff), opts())
    expect(all).toHaveLength(2)
    expect((await centers(all)).map(dominant)).toEqual([0, 1])
    const log = vi.fn()
    const capped = await renderVariants(new Uint8Array(tiff), opts({ maxRenders: 1, log }))
    expect(capped).toHaveLength(1)
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/省略 1 件/))
  })

  it('EXIF の向き（6 = 90 度回転）を反映する: 40x20 → 20x40', async () => {
    const jpeg = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#f00' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()
    const vs = await renderVariants(new Uint8Array(jpeg), opts())
    const meta = await sharp(vs[0]!.image).metadata()
    expect([meta.width, meta.height]).toEqual([20, 40])
  })

  it('HEIC は unsupported', async () => {
    const heic = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x68, 0x65, 0x69, 0x63, 0x6d, 0x69, 0x66, 0x31])
    await expect(renderVariants(heic, opts())).rejects.toMatchObject({ kind: 'unsupported' })
  })
})
