// レイヤー付き画像の描画変種を作る。PSD は自前で合成し、ラスターは sharp で 1 ページずつ読む。
// ponytail: 合成は normal ブレンドの alpha over のみ。未対応（再現しない・無視する）: スマートフィルター、レイヤー効果、normal 以外のブレンドモード、クリッピングマスク、fillOpacity。
// ponytail: グループの不透明度・マスクは子に掛けない。2 枚以上にまたがるモザイクは検出しない（1 枚ずつ外す変種だけ）。
// ponytail: PSB と 8bit 以外（16/32bit）の PSD は unsupported。対応するなら読み出し部で 8bit に落とす（16bit は >>8、32bit は *255）。
// ponytail: 合成は全画素の JS ループ。大きい PSD は遅いので、遅ければ sharp 側の合成に寄せる。
// ponytail: 展開の上限はレイヤーの確保量の合計（maxPixels × 4 バイト）。多数の中サイズレイヤーの正当な PSD も弾く。
import { initializeCanvas, readPsd, type Layer, type PixelData, type Psd } from 'ag-psd'
import sharp from 'sharp'
import { sniff } from './images.ts'
import { CheckError, PsdRenderLimitError } from './types.ts'

// ag-psd は既定で canvas パッケージを要求する。ピクセルは素の配列で扱うので、canvas は使わない。
initializeCanvas(
  () => {
    throw new Error('canvas は使わない')
  },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData,
)

export interface Variant {
  description: string
  render: () => Promise<Uint8Array>
}
export interface RenderOptions {
  maxRenders: number
  maxFrames: number
  maxAnimSeconds: number
  layerPattern: string
  maxPixels: number
}

/** PSD のノード（グループ・レイヤー）。chain は自分と祖先の id。 */
interface Item {
  id: number
  name: string
  layer: Layer
  chain: number[]
  leaf: boolean
}

/** sharp は APNG の各フレームを取得できないため、acTL があれば拒否する。 */
function isApng(data: Uint8Array): boolean {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (let offset = 8; offset + 12 <= view.byteLength;) {
    const type = view.getUint32(offset + 4)
    if (type === 0x6163544c) return true // acTL
    if (type === 0x49444154) break // IDAT
    offset += 12 + view.getUint32(offset)
  }
  return false
}

const flatten = (layers: Layer[], chain: number[] = [], out: Item[] = []): Item[] => {
  for (const layer of layers) {
    const item: Item = { id: out.length, name: layer.name ?? '', layer, chain: [], leaf: !layer.children }
    item.chain = [...chain, item.id]
    out.push(item)
    if (layer.children) flatten(layer.children, item.chain, out)
  }
  return out
}

async function encodePng(data: ArrayLike<number>, w: number, h: number): Promise<Uint8Array> {
  const raw = new Uint8ClampedArray(data)
  return sharp(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toBuffer()
}

/** 1 枚のレイヤーを out に alpha over で重ねる。不透明度とレイヤーマスクを掛ける。 */
function blend(out: Uint8ClampedArray, W: number, H: number, layer: Layer, img: PixelData): void {
  const left = layer.left ?? 0
  const top = layer.top ?? 0
  const op = layer.opacity ?? 1
  const mask = layer.mask && !layer.mask.disabled ? layer.mask : undefined
  const mimg = mask?.imageData
  // マスクの座標はキャンバス基準（positionRelativeToLayer ならレイヤー基準）
  const mOx = mask?.positionRelativeToLayer ? left : 0
  const mOy = mask?.positionRelativeToLayer ? top : 0
  for (let y = 0; y < img.height; y++) {
    const dy = y + top
    if (dy < 0 || dy >= H) continue
    for (let x = 0; x < img.width; x++) {
      const dx = x + left
      if (dx < 0 || dx >= W) continue
      const si = (y * img.width + x) * 4
      let sa = ((img.data[si + 3] ?? 0) / 255) * op
      if (mask) {
        // マスク画素が無い、または範囲外は defaultColor（既定 0 = 隠す）
        const mx = dx - mOx - (mask.left ?? 0)
        const my = dy - mOy - (mask.top ?? 0)
        const inside = mimg !== undefined && mx >= 0 && my >= 0 && mx < mimg.width && my < mimg.height
        const m = inside ? (mimg.data[(my * mimg.width + mx) * 4] ?? 0) : (mask.defaultColor ?? 0)
        sa *= m / 255
      }
      if (sa <= 0) continue
      const di = (dy * W + dx) * 4
      const da = (out[di + 3] ?? 0) / 255
      const oa = sa + da * (1 - sa)
      for (let c = 0; c < 3; c++) {
        out[di + c] = ((img.data[si + c] ?? 0) * sa + (out[di + c] ?? 0) * da * (1 - sa)) / oa
      }
      out[di + 3] = oa * 255
    }
  }
}

/** 展開前にヘッダで判定する。PSB・8bit 以外・画素数超過は画素を読まずに拒否する。 */
function checkPsdHeader(data: Uint8Array, maxPixels: number): void {
  const version = (data[4] ?? 0) * 256 + (data[5] ?? 0)
  if (version === 2) throw new CheckError('unsupported', 'PSB は未対応です')
  if (data.length < 24) return // 短すぎるものは readPsd が bad_input にする
  // ヘッダ: 高さ @14、幅 @18、ビット深度 @22（いずれも BE）
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (dv.getUint16(22) !== 8) throw new CheckError('unsupported', '8bit 以外（16/32bit）の PSD は未対応です')
  if (dv.getUint32(14) * dv.getUint32(18) > maxPixels) throw new CheckError('bad_input', '画素数が上限を超えています')
}

/** ag-psd・sharp の例外は入力の問題として bad_input にする。CheckError はそのまま通す。 */
async function decode<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof CheckError) throw e
    throw new CheckError('bad_input', 'レイヤー付き画像を描画できません')
  }
}

async function psdPlans(data: Uint8Array, opts: RenderOptions, re: RegExp): Promise<Variant[]> {
  checkPsdHeader(data, opts.maxPixels)
  // レイヤーの確保量の合計を maxPixels 画素分（4 バイト/画素）に抑える。超えると ag-psd が確保前に例外を投げる。
  const psd: Psd = await decode(() =>
    readPsd(data.slice().buffer, { useImageData: true, skipThumbnail: true, totalMemoryLimit: opts.maxPixels * 4 }),
  )
  const W = psd.width
  const H = psd.height

  const items = flatten(psd.children ?? [])
  const asIs = (it: Item): boolean => !it.layer.hidden
  // 祖先を含め、すべてが show を満たすときだけ見える
  const visibleIn = (it: Item, show: (x: Item) => boolean): boolean => it.chain.every((id) => show(items[id] as Item))
  const compose = (show: (x: Item) => boolean): Promise<Uint8Array> => {
    const out = new Uint8ClampedArray(W * H * 4)
    for (const it of items) {
      const img = it.layer.imageData
      if (it.leaf && img && visibleIn(it, show)) blend(out, W, H, it.layer, img)
    }
    return encodePng(out, W, H)
  }

  const leaves = items.filter((it) => it.leaf && it.layer.imageData && visibleIn(it, asIs))
  // 自分または祖先の名前がパターンに合う可視レイヤー（グループ名も数える）
  const named = (it: Item): boolean => it.chain.some((id) => re.test((items[id] as Item).name))
  const matched = leaves.filter(named)
  const plans: Variant[] = [
    {
      description: '見えているとおり',
      render: () =>
        psd.imageData
          ? encodePng(psd.imageData.data, psd.imageData.width, psd.imageData.height)
          : compose(asIs),
    },
    { description: '非表示レイヤーも表示', render: () => compose(() => true) },
  ]
  // 合致するレイヤーが無ければ、見えているとおりと同じ画像になるので作らない
  if (matched.length > 0) {
    plans.push({
      description: 'モザイク名のレイヤーを非表示',
      render: () => compose((it) => asIs(it) && !re.test(it.name)),
    })
  }
  // 可視の画素レイヤーを上から 1 枚ずつ外す（名前を変えたモザイク層を拾う）
  for (const leaf of [...leaves].reverse()) {
    // 合致が 1 枚だけなら、その 1 枚を外す変種はモザイク名の変種と同じなので省く
    if (matched.length === 1 && matched[0] === leaf) continue
    plans.push({
      description: `「${leaf.name}」を外す`,
      render: () => compose((it) => asIs(it) && it.id !== leaf.id),
    })
  }
  return plans
}

async function rasterPlans(data: Uint8Array, opts: RenderOptions, format: ReturnType<typeof sniff>): Promise<Variant[]> {
  if (format === 'unsupported' || (format === 'png' && isApng(data))) {
    throw new CheckError('unsupported', '未対応の画像形式です')
  }
  const meta = await decode(() => sharp(data, { limitInputPixels: opts.maxPixels }).metadata())
  const pages = meta.pages ?? 1
  const h = meta.pageHeight ?? meta.height ?? 0
  if ((meta.width ?? 0) * h > opts.maxPixels) throw new CheckError('bad_input', '画素数が上限を超えています')
  if (pages > opts.maxFrames) throw new CheckError('too_large', 'フレーム数が上限を超えています')
  const timed = pages > 1 && (format === 'gif' || format === 'webp')
  if (timed) {
    const delay = meta.delay ?? []
    const duration = Array.from({ length: pages }, (_, i) => delay[i] ?? 0)
      .reduce((sum, ms) => sum + (ms > 0 ? ms : 10), 0)
    if (duration > opts.maxAnimSeconds * 1000) throw new CheckError('too_large', '再生時間が上限を超えています')
  }
  return Array.from({ length: pages }, (_, i) => ({
    description: timed ? `フレーム ${i + 1}/${pages}` : pages > 1 ? `ページ ${i + 1}/${pages}` : 'ラスター',
    // rotate() は EXIF の向きを画素に反映し、向きタグを落とす（後段の正規化で二重に回さないため）
    render: () => decode(() => sharp(data, { page: i, limitInputPixels: opts.maxPixels }).rotate().png().toBuffer()),
  }))
}

/** 上限を確認し、各描画を必要になったときに生成する。 */
export async function renderVariants(data: Uint8Array, opts: RenderOptions): Promise<Variant[]> {
  const format = sniff(data)
  if (format !== 'psd') return rasterPlans(data, opts, format)
  // 層名パターンの誤りは設定の問題なので、入力の問題（bad_input）にはしない
  let re: RegExp
  try {
    re = new RegExp(opts.layerPattern, 'i')
  } catch {
    throw new CheckError('internal', '層名パターンが不正です')
  }
  try {
    const plans = await psdPlans(data, opts, re)
    if (plans.length > opts.maxRenders) throw new PsdRenderLimitError(plans.length, opts.maxRenders)
    return plans
  } catch (e) {
    if (e instanceof CheckError) throw e
    throw new CheckError('internal', 'レイヤー付き画像の描画で内部エラーが起きました')
  }
}
