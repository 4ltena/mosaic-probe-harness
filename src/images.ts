import sharp from 'sharp'
import type { Metadata } from 'sharp'
import { CheckError } from './types.ts'

export type Format = 'png' | 'jpeg' | 'webp' | 'gif' | 'tiff' | 'psd' | 'unsupported'
export const MODEL_IMAGE_MIME = 'image/png'

const ascii = (data: Uint8Array, start: number, text: string): boolean => {
  if (data.length < start + text.length) return false
  for (let i = 0; i < text.length; i++) if (data[start + i] !== text.charCodeAt(i)) return false
  return true
}

/** 先頭バイトで形式を判定する（拡張子は見ない）。 */
export function sniff(data: Uint8Array): Format {
  if (data.length >= 8 && data[0] === 0x89 && ascii(data, 1, 'PNG\r\n\x1a\n')) return 'png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg'
  if (data.length >= 12 && ascii(data, 0, 'RIFF') && ascii(data, 8, 'WEBP')) return 'webp'
  if (ascii(data, 0, 'GIF87a') || ascii(data, 0, 'GIF89a')) return 'gif'
  if (ascii(data, 0, 'II*\x00') || ascii(data, 0, 'MM\x00*')) return 'tiff'
  if (ascii(data, 0, '8BPS')) return 'psd'
  // HEIC/HEIF/AVIF などの ftyp は未対応（HEIC は明示的に拒否する）
  return 'unsupported'
}

/** data URI・改行を許容して base64 を復号する。上限は文字列長で先に判定する。 */
export function decodeBase64(s: string, maxMb: number): Uint8Array {
  const maxBytes = Math.floor(maxMb * 1024 * 1024)
  // 改行を含む入力に余裕を持たせた生の文字列長の上限（デコード前）
  if (s.length > Math.ceil(maxBytes / 3) * 4 * 1.1 + 1024) {
    throw new CheckError('bad_input', '画像が大きすぎます')
  }
  const body = s.replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '')
  if (body.length === 0 || body.length > Math.ceil(maxBytes / 3) * 4) {
    throw new CheckError('bad_input', 'base64 が空、または大きすぎます')
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length % 4 === 1) {
    throw new CheckError('bad_input', 'base64 に不正な文字があります')
  }
  const bytes = new Uint8Array(Buffer.from(body, 'base64'))
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw new CheckError('bad_input', '画像のサイズが不正です')
  }
  return bytes
}

/** 縮小のみ・EXIF の向きを反映し、透過を白に合成して 8bit の RGB PNG にする。 */
export async function normalize(
  data: Uint8Array,
  opts: { maxEdge: number; maxPixels: number },
): Promise<Uint8Array> {
  if (sniff(data) === 'unsupported') throw new CheckError('unsupported', '未対応の画像形式です')
  const input = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  let meta: Metadata
  try {
    meta = await sharp(input).metadata()
  } catch {
    throw new CheckError('bad_input', '画像を読めません')
  }
  if (!meta.width || !meta.height || meta.width * meta.height > opts.maxPixels) {
    throw new CheckError('bad_input', '画素数が上限を超えています')
  }
  try {
    // 画素数の上限は上の metadata の検査だけで守る（同じ値を sharp にも渡すと二重になり、どちらを外しても検出できなかった）
    const out = await sharp(input)
      .rotate() // EXIF の向きを反映
      .resize({ width: opts.maxEdge, height: opts.maxEdge, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .png({ palette: false })
      .toBuffer()
    return new Uint8Array(out)
  } catch {
    throw new CheckError('bad_input', '画像のデコードに失敗しました')
  }
}
