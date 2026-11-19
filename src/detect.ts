// 前段の画風分類と部位検出（DETECT=1 のときだけ使う）。ONNX ランタイムは動的に読み込む。
// 前処理・後処理は dghs-imgutils（stretch）、Ultralytics（letterbox）、NudeNet（pad）に合わせる。
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'
import type { Config, DetectorSpec, ResizeMode } from './config.ts'
import { CheckError } from './types.ts'

/** 元の描画の画素座標の箱（整数）。label はクラス名。 */
export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
  label: string
  score: number
}

/** 対象のクラスに絞り、スコアの高い順に DETECT_MAX_CROPS 件までにした箱を返す。 */
export type Detector = (png: Uint8Array, signal?: AbortSignal) => Promise<Box[]>

// --- onnxruntime-node の使う部分だけの構造型（型としても静的に import しない） ---
export interface OrtTensor {
  readonly dims: readonly number[]
  readonly data: unknown
}
export interface OrtSession {
  readonly inputNames: readonly string[]
  readonly outputNames: readonly string[]
  /** 静的な次元は数、動的な次元は記号名の文字列。 */
  readonly inputMetadata?: readonly { readonly shape?: readonly (number | string)[] }[]
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor | undefined>>
}
export interface Ort {
  InferenceSession: {
    create(model: Uint8Array, opts: { intraOpNumThreads: number; logSeverityLevel: number }): Promise<OrtSession>
  }
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => OrtTensor
}

// 文字列リテラルで import しない（パッケージがなくても tsc が TS2307 で落ちないように）
const ORT: string = 'onnxruntime-node'

const STYLE_SIZE = 384

/** numpy / Python の round（ちょうど半分は偶数へ）。 */
export function roundHalfEven(v: number): number {
  const f = Math.floor(v)
  const d = v - f
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1
}

/** Ultralytics の LetterBox の配置。奇数の余白は下と右が 1 多い。 */
export function letterboxLayout(w: number, h: number, W: number, H: number) {
  const r = Math.min(H / h, W / w)
  const nw = roundHalfEven(w * r)
  const nh = roundHalfEven(h * r)
  const dw = (W - nw) / 2
  const dh = (H - nh) / 2
  return {
    r, nw, nh,
    top: roundHalfEven(dh - 0.1), bottom: roundHalfEven(dh + 0.1),
    left: roundHalfEven(dw - 0.1), right: roundHalfEven(dw + 0.1),
  }
}

/** モデル座標 v を元の座標に戻す式 (v − o) / g の係数。 */
export interface Mapping {
  ox: number
  oy: number
  gx: number
  gy: number
}

export function mapping(mode: ResizeMode, w: number, h: number, W: number, H: number): Mapping {
  if (mode === 'stretch') return { ox: 0, oy: 0, gx: W / w, gy: H / h }
  if (mode === 'pad') {
    const side = Math.max(w, h)
    return { ox: 0, oy: 0, gx: W / side, gy: H / side }
  }
  const l = letterboxLayout(w, h, W, H)
  return { ox: l.left, oy: l.top, gx: l.r, gy: l.r }
}

/** HWC の RGB（8bit）を CHW の float32 にする。 */
function chw(raw: Uint8Array, f: (v: number) => number): Float32Array {
  const n = raw.length / 3
  const out = new Float32Array(raw.length)
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[c * n + i] = f(raw[i * 3 + c]!)
  return out
}

const rgb = (png: Uint8Array) => sharp(png).removeAlpha().toColourspace('srgb')

/** 検出器の入力 [3,H,W]（0〜1）と、元の座標に戻す係数。 */
export async function toTensor(png: Uint8Array, mode: ResizeMode, W: number, H: number) {
  const { width: w, height: h } = await sharp(png).metadata()
  let raw: Buffer
  if (mode === 'stretch') {
    raw = await rgb(png).resize(W, H, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer()
  } else if (mode === 'letterbox') {
    const l = letterboxLayout(w, h, W, H)
    raw = await rgb(png).resize(l.nw, l.nh, { fit: 'fill', kernel: 'linear' })
      .extend({ top: l.top, bottom: l.bottom, left: l.left, right: l.right, background: { r: 114, g: 114, b: 114 } })
      .raw().toBuffer()
  } else {
    // sharp は extend を resize の後に行うので、正方形にしてから別の処理で縮める
    const side = Math.max(w, h)
    const sq = await rgb(png).extend({ bottom: side - h, right: side - w, background: { r: 0, g: 0, b: 0 } }).raw().toBuffer()
    raw = await sharp(sq, { raw: { width: side, height: side, channels: 3 } })
      .resize(W, H, { fit: 'fill', kernel: 'linear' }).raw().toBuffer()
  }
  return { data: chw(raw, (v) => v / 255), map: mapping(mode, w, h, W, H), w, h }
}

/** 画風の分類器の入力 [3,384,384]。PIL の bilinear 相当で縮め、(x − 0.5) / 0.5 にする。 */
export async function styleTensor(png: Uint8Array): Promise<Float32Array> {
  const raw = await rgb(png).resize(STYLE_SIZE, STYLE_SIZE, { fit: 'fill', kernel: 'linear' }).raw().toBuffer()
  return chw(raw, (v) => (v / 255 - 0.5) / 0.5)
}

/** 重なりの面積を +1 の規約で数えた IoU（imgutils と同じ）。 */
export function iou(a: Box, b: Box): number {
  const area = (r: Box) => (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1)
  const iw = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1)
  const ih = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1)
  const inter = iw * ih
  return inter / (area(a) + area(b) - inter)
}

/** クラスを区別しない NMS。スコアの高い順（同点は元の並び）に、残した箱と IoU ≤ thr の箱を残す。 */
export function nms(boxes: readonly Box[], thr: number): Box[] {
  const keep: Box[] = []
  for (const b of [...boxes].sort((p, q) => q.score - p.score)) {
    if (keep.every((k) => iou(k, b) <= thr)) keep.push(b)
  }
  return keep
}

/**
 * 検出器の出力 [1, 4+nc, n] の data を、元の座標の箱にする（対象クラスでは絞らない）。
 * しきい値は `>`、xywh → xyxy、モデル座標で NMS、戻してから [0, w]・[0, h] に切り詰めて丸める。
 */
export function decode(
  data: ArrayLike<number>, n: number, labels: readonly string[], threshold: number, iouThr: number,
  m: Mapping, w: number, h: number,
): Box[] {
  // imgutils は float32 のまま比べるので、しきい値も float32 に丸めて比べる
  const thr = Math.fround(threshold)
  const cand: Box[] = []
  for (let j = 0; j < n; j++) {
    let best = 0
    let score = -Infinity
    for (let c = 0; c < labels.length; c++) {
      const s = data[(4 + c) * n + j]!
      if (s > score) {
        score = s
        best = c
      }
    }
    if (!(score > thr)) continue
    const cx = data[j]!
    const cy = data[n + j]!
    const bw = data[2 * n + j]!
    const bh = data[3 * n + j]!
    cand.push({ x0: cx - bw / 2, y0: cy - bh / 2, x1: cx + bw / 2, y1: cy + bh / 2, label: labels[best]!, score })
  }
  const back = (v: number, o: number, g: number, lim: number) => roundHalfEven(Math.min(Math.max((v - o) / g, 0), lim))
  return nms(cand, iouThr).map((b) => ({
    ...b,
    x0: back(b.x0, m.ox, m.gx, w), y0: back(b.y0, m.oy, m.gy, h),
    x1: back(b.x1, m.ox, m.gx, w), y1: back(b.y1, m.oy, m.gy, h),
  }))
}

/** 出力の形・型・NaN・無限大を確かめる。違えば internal。 */
export function checkOutput(t: OrtTensor | undefined, ok: (dims: readonly number[]) => boolean) {
  if (!t || !(t.data instanceof Float32Array) || !ok(t.dims) || t.data.length !== t.dims.reduce((a, b) => a * b, 1)) {
    throw new CheckError('internal', 'ONNX の出力の形が想定と違います')
  }
  for (const v of t.data) if (!Number.isFinite(v)) throw new CheckError('internal', 'ONNX の出力に NaN か無限大があります')
  return { data: t.data, dims: t.dims }
}

/** 分類器の出力を確率にする。すでに確率（0〜1 で合計がほぼ 1）なら、そのまま使う。 */
export function toProbs(v: ArrayLike<number>): number[] {
  const a = Array.from(v)
  const sum = a.reduce((s, x) => s + x, 0)
  if (a.every((x) => x >= 0 && x <= 1) && Math.abs(sum - 1) < 1e-3) return a
  const mx = Math.max(...a)
  const e = a.map((x) => Math.exp(x - mx))
  const z = e.reduce((s, x) => s + x, 0)
  return e.map((x) => x / z)
}

/** Python の dict の表記 `{0: 'a', 1: 'b'}` を読む。キーが 0 からの連番でなければ undefined。 */
export function parseNames(s: string): string[] | undefined {
  const m = /^\s*\{(.*)\}\s*$/su.exec(s)
  if (!m) return undefined
  const entry = /^\s*(\d+)\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*(?:,|$)/su
  const out: string[] = []
  let rest = m[1]!
  while (rest.trim() !== '') {
    const e = entry.exec(rest)
    if (!e || Number(e[1]) !== out.length) return undefined
    out.push((e[2] ?? e[3]!).replace(/\\(.)/gsu, '$1'))
    rest = rest.slice(e[0].length)
  }
  return out.length > 0 ? out : undefined
}

/** protobuf の 1 階層を (フィールド番号, 値) で列挙する。LEN は部分配列、varint は数。 */
function* fields(buf: Uint8Array): Generator<[number, Uint8Array | number]> {
  let p = 0
  const varint = (): number => {
    let v = 0
    let mul = 1
    for (;;) {
      if (p >= buf.length || mul > 2 ** 63) throw new Error('protobuf の varint が不正です')
      const b = buf[p++]!
      v += (b & 0x7f) * mul
      mul *= 128
      if (b < 0x80) return v
    }
  }
  while (p < buf.length) {
    const key = varint()
    const wire = key % 8
    const field = Math.floor(key / 8)
    if (wire === 0) yield [field, varint()]
    else if (wire === 2) {
      const len = varint()
      if (p + len > buf.length) throw new Error('protobuf の長さが不正です')
      yield [field, buf.subarray(p, p + len)]
      p += len
    } else if (wire === 1 || wire === 5) {
      p += wire === 1 ? 8 : 4
      if (p > buf.length) throw new Error('protobuf の長さが不正です')
    } else throw new Error('protobuf の形式が不正です')
  }
}

/** ModelProto の metadata_props（フィールド 14、StringStringEntryProto の key=1・value=2）を読む。 */
export function readMetadata(model: Uint8Array): Map<string, string> {
  const text = new TextDecoder()
  const out = new Map<string, string>()
  for (const [f, v] of fields(model)) {
    if (f !== 14 || typeof v === 'number') continue
    let key = ''
    let value = ''
    for (const [g, s] of fields(v)) {
      if (typeof s === 'number') continue
      if (g === 1) key = text.decode(s)
      else if (g === 2) value = text.decode(s)
    }
    out.set(key, value)
  }
  return out
}

/** 入力の寸法 [H, W]。付属情報 imgsz（Ultralytics の [h, w]）があればそれ、なければ 640×640。 */
export function inputSize(imgsz: string | undefined): [number, number] {
  if (imgsz === undefined) return [640, 640]
  const v: unknown = JSON.parse(imgsz)
  const a = typeof v === 'number' ? [v, v] : Array.isArray(v) && v.length === 1 ? [v[0], v[0]] : v
  if (!Array.isArray(a) || a.length !== 2 || !a.every((x) => Number.isSafeInteger(x) && x > 0)) {
    throw new Error('imgsz が不正です')
  }
  return [a[0], a[1]]
}

// --- ORT のセッションと起動時の検査 ---

type Kind = 'DETECT_ANIME' | 'DETECT_PHOTO' | 'STYLE'

interface Det {
  spec: DetectorSpec
  session: OrtSession
  labels: string[]
  H: number
  W: number
  shape: (d: readonly number[]) => boolean
}

function asOrt(m: unknown): Ort {
  const o = m as Partial<Ort> & { default?: Partial<Ort> }
  const r = o.InferenceSession ? o : o.default
  if (typeof r?.InferenceSession?.create !== 'function' || typeof r.Tensor !== 'function') throw new Error('not ORT')
  return r as Ort
}

async function readModel(kind: Kind, path: string, sha256: string | undefined): Promise<Buffer> {
  if (!existsSync(path)) throw new Error(`${kind}_MODEL のファイルがありません`)
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch {
    throw new Error(`${kind}_MODEL のファイルを読めません`)
  }
  if (sha256 !== undefined && createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error(`${kind}_SHA256 がモデルファイルと一致しません`)
  }
  return bytes
}

async function openSession(ort: Ort, kind: Kind, bytes: Buffer, threads: number): Promise<OrtSession> {
  try {
    // 照合した Buffer からそのまま作る（照合と読み込みのすき間を作らない）
    return await ort.InferenceSession.create(bytes, { intraOpNumThreads: threads, logSeverityLevel: 3 })
  } catch {
    throw new Error(`${kind}_MODEL を ONNX のモデルとして読み込めません`)
  }
}

async function infer(
  ort: Ort, s: OrtSession, data: Float32Array, H: number, W: number,
  ok: (d: readonly number[]) => boolean, signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const out = await s.run({ [s.inputNames[0]!]: new ort.Tensor('float32', data, [1, 3, H, W]) })
  signal?.throwIfAborted()
  return checkOutput(out[s.outputNames[0]!], ok)
}

/** 入力の形が静的で前処理の寸法と違えば止め、ゼロの入力で試しに推論して出力の形を確かめる。 */
async function tryRun(ort: Ort, kind: Kind, s: OrtSession, H: number, W: number, ok: (d: readonly number[]) => boolean) {
  const shape = s.inputMetadata?.[0]?.shape
  if (shape && (shape.length !== 4 || [H, W].some((n, i) => typeof shape[i + 2] === 'number' && shape[i + 2] !== n))) {
    throw new Error(`${kind}_MODEL の入力の形が前処理の寸法と違います`)
  }
  try {
    await infer(ort, s, new Float32Array(3 * H * W), H, W, ok)
  } catch {
    throw new Error(`${kind}_MODEL の試しの推論に失敗しました（出力の形が想定と違う場合を含む）`)
  }
}

async function openDetector(ort: Ort, kind: Kind, spec: DetectorSpec, bytes: Buffer, threads: number): Promise<Det> {
  const session = await openSession(ort, kind, bytes, threads)
  let meta: Map<string, string>
  let size: [number, number]
  try {
    meta = readMetadata(bytes)
    size = inputSize(meta.get('imgsz'))
  } catch {
    throw new Error(`${kind}_MODEL の付属情報を読めません`)
  }
  const names = meta.get('names')
  const labels = names === undefined ? spec.labels : parseNames(names)
  if (labels === undefined) {
    throw new Error(names === undefined
      ? `${kind}_LABELS が必要です（モデルにクラス名の付属情報がありません）`
      : `${kind}_MODEL の付属情報 names を読めません`)
  }
  if (!spec.classes.every((c) => labels.includes(c))) throw new Error(`${kind}_CLASSES にラベルにないクラスがあります`)
  const [H, W] = size
  const shape = (d: readonly number[]) => d.length === 3 && d[0] === 1 && d[1] === 4 + labels.length
  await tryRun(ort, kind, session, H, W, shape)
  return { spec, session, labels, H, W, shape }
}

/**
 * 起動時に呼ぶ。検査の順序: ファイル → 1 回だけ読んで SHA-256 → ランタイム → Buffer からセッション → ラベル → 試しの推論。
 * 失敗は、変数名だけを示す固定の文言にする（パスや ORT の文言は出さない）。
 */
export async function createDetector(
  cfg: Config, root: string, load: () => Promise<unknown> = () => import(ORT),
): Promise<Detector> {
  const pairs: [Kind, DetectorSpec | undefined][] = [['DETECT_ANIME', cfg.detectAnime], ['DETECT_PHOTO', cfg.detectPhoto]]
  const specs = pairs.filter((e): e is [Kind, DetectorSpec] => e[1] !== undefined)
  const style = cfg.style
  if (specs.length === 0 || (style !== undefined) !== (specs.length === 2)) {
    throw new Error('DETECT=1 の検出器と STYLE_MODEL の組み合わせが不正です')
  }
  const bytes: Buffer[] = []
  for (const [kind, s] of specs) bytes.push(await readModel(kind, resolve(root, s.model), s.sha256))
  const styleBytes = style && (await readModel('STYLE', resolve(root, style.model), style.sha256))
  let ort: Ort
  try {
    ort = asOrt(await load())
  } catch {
    throw new Error('DETECT=1 には onnxruntime-node が必要です（読み込めません。Windows では VC++ 再頒布可能パッケージを確かめてください）')
  }
  const threads = cfg.detectThreads
  const dets: Det[] = []
  for (const [i, [kind, s]] of specs.entries()) dets.push(await openDetector(ort, kind, s, bytes[i]!, threads))
  let cls: { session: OrtSession; real: number; shape: (d: readonly number[]) => boolean } | undefined
  if (style && styleBytes) {
    const session = await openSession(ort, 'STYLE', styleBytes, threads)
    const real = style.labels.indexOf('real')
    if (real < 0) throw new Error('STYLE_LABELS に real が必要です')
    const shape = (d: readonly number[]) => d.length === 2 && d[0] === 1 && d[1] === style.labels.length
    await tryRun(ort, 'STYLE', session, STYLE_SIZE, STYLE_SIZE, shape)
    cls = { session, real, shape }
  }
  const iouThr = cfg.detectIou
  const max = cfg.detectMaxCrops

  return async (png, signal) => {
    signal?.throwIfAborted()
    let use = dets
    if (style && cls) {
      // 検出器は [イラスト用, 写真用] の順
      const out = await infer(ort, cls.session, await styleTensor(png), STYLE_SIZE, STYLE_SIZE, cls.shape, signal)
      const p = toProbs(out.data)[cls.real]!
      use = p >= style.realHi ? [dets[1]!] : p <= style.realLo ? [dets[0]!] : dets
    }
    const lists: Box[][] = []
    for (const d of use) {
      const t = await toTensor(png, d.spec.resize, d.W, d.H)
      const out = await infer(ort, d.session, t.data, d.H, d.W, d.shape, signal)
      const boxes = decode(out.data, out.dims[2]!, d.labels, d.spec.threshold, iouThr, t.map, t.w, t.h)
      lists.push(boxes.filter((b) => d.spec.classes.includes(b.label)))
    }
    const all = lists.flat()
    // 2 つの検出器なら、まとめてもう一度 NMS（同点は検出器の順、次に元の並び）
    return (lists.length > 1 ? nms(all, iouThr) : all).slice(0, max)
  }
}
