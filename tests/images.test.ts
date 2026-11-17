import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { sniff, decodeBase64, normalize } from '../src/images.ts'
import { CheckError } from '../src/types.ts'

// 例外の種類を取り出す（CheckError 以外は 'other'）
function kindOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (e) {
    return e instanceof CheckError ? e.kind : 'other'
  }
  return undefined
}

async function kindOfAsync(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
  } catch (e) {
    return e instanceof CheckError ? e.kind : 'other'
  }
  return undefined
}

const enc = (s: string) => new TextEncoder().encode(s)

// 赤一色の画像（sharp で合成）
async function solid(
  w: number,
  h: number,
  format: 'png' | 'jpeg' | 'webp' | 'gif' | 'tiff',
  alpha = 1,
): Promise<Uint8Array> {
  const img = sharp({ create: { width: w, height: h, channels: 4, background: { r: 255, g: 0, b: 0, alpha } } })
  const buf = await img[format]().toBuffer()
  return new Uint8Array(buf)
}

describe('sniff', () => {
  it('ラスター形式を先頭バイトで判別する', async () => {
    expect(sniff(await solid(4, 4, 'png'))).toBe('png')
    expect(sniff(await solid(4, 4, 'jpeg'))).toBe('jpeg')
    expect(sniff(await solid(4, 4, 'webp'))).toBe('webp')
    expect(sniff(await solid(4, 4, 'gif'))).toBe('gif')
    expect(sniff(await solid(4, 4, 'tiff'))).toBe('tiff')
  })

  it('PSD は 8BPS で判別する', () => {
    expect(sniff(enc('8BPS\x00\x01\x00\x00\x00\x00\x00\x00'))).toBe('psd')
  })

  it('未対応形式と不正入力は unsupported', () => {
    expect(sniff(enc('BM\x00\x00\x00\x00'))).toBe('unsupported') // BMP
    expect(sniff(enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('unsupported')
    // HEIC: ftyp ボックスの brand が heic
    expect(sniff(enc('\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic'))).toBe('unsupported')
    expect(sniff(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]))).toBe('unsupported')
    expect(sniff(new Uint8Array(0))).toBe('unsupported')
  })
})

describe('decodeBase64', () => {
  const payload = new Uint8Array(200).map((_, i) => (i * 37) & 0xff)
  const b64 = Buffer.from(payload).toString('base64')

  it('素の base64・data URI 付き・76 桁改行入りを同じバイト列に戻す', () => {
    expect(Buffer.from(decodeBase64(b64, 15))).toEqual(Buffer.from(payload))
    expect(Buffer.from(decodeBase64(`data:image/png;base64,${b64}`, 15))).toEqual(Buffer.from(payload))
    const wrapped = b64.match(/.{1,76}/g)!.join('\r\n')
    expect(Buffer.from(decodeBase64(wrapped, 15))).toEqual(Buffer.from(payload))
  })

  it('上限超過は bad_input（文字列長で判定）', () => {
    const big = 'A'.repeat(20_000) // 約 15KB 相当の上限を大きく超える
    expect(kindOf(() => decodeBase64(big, 0.001))).toBe('bad_input')
  })

  it('不正文字・空は bad_input', () => {
    expect(kindOf(() => decodeBase64('ab!cd', 15))).toBe('bad_input')
    expect(kindOf(() => decodeBase64('', 15))).toBe('bad_input')
    expect(kindOf(() => decodeBase64('data:image/png;base64,', 15))).toBe('bad_input')
  })
})

describe('normalize', () => {
  it('透過 PNG が JPEG になる', async () => {
    const png = await solid(16, 16, 'png', 0.5)
    const out = await normalize(png, { maxEdge: 64, maxPixels: 1_000_000 })
    expect(sniff(out)).toBe('jpeg')
  })

  it('長辺は maxEdge 以下になる', async () => {
    const wide = await solid(300, 100, 'png')
    const out = await normalize(wide, { maxEdge: 64, maxPixels: 1_000_000 })
    const meta = await sharp(out).metadata()
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(64)
    expect(meta.width).toBe(64)
  })

  it('小さい画像は拡大されない', async () => {
    const small = await solid(20, 10, 'png')
    const out = await normalize(small, { maxEdge: 64, maxPixels: 1_000_000 })
    const meta = await sharp(out).metadata()
    expect([meta.width, meta.height]).toEqual([20, 10])
  })

  it('EXIF の向きを反映する（幅と高さが入れ替わる）', async () => {
    // 幅 40・高さ 20 の JPEG に EXIF orientation=6（90 度回転）を付ける
    const jpeg = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#00ff00' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()
    const out = await normalize(new Uint8Array(jpeg), { maxEdge: 2048, maxPixels: 1_000_000 })
    const meta = await sharp(out).metadata()
    expect([meta.width, meta.height]).toEqual([20, 40])
  })

  it('maxPixels 超過は bad_input（画素数のメッセージで拒否したことも確かめる）', async () => {
    const img = await solid(100, 100, 'png')
    const err = await normalize(img, { maxEdge: 64, maxPixels: 5000 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CheckError)
    expect((err as CheckError).kind).toBe('bad_input')
    expect((err as CheckError).message).toContain('画素数')
  })

  it('壊れたバイト列（PNG 署名だけ）は bad_input', async () => {
    const broken = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...enc('garbage-garbage')])
    expect(await kindOfAsync(normalize(broken, { maxEdge: 64, maxPixels: 1_000_000 }))).toBe('bad_input')
  })

  it('未対応形式は unsupported', async () => {
    const bmp = enc('BM\x00\x00\x00\x00\x00\x00\x00\x00')
    expect(await kindOfAsync(normalize(bmp, { maxEdge: 64, maxPixels: 1_000_000 }))).toBe('unsupported')
    const svg = enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect(await kindOfAsync(normalize(svg, { maxEdge: 64, maxPixels: 1_000_000 }))).toBe('unsupported')
  })
})
