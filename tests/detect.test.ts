import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import {
  checkOutput, createDetector, decode, inputSize, iou, letterboxLayout, mapping, nms, parseNames, readMetadata,
  roundHalfEven, styleTensor, toProbs, toTensor, type Box,
} from '../src/detect.ts'
import { defaultConfig, type Config, type DetectorSpec, type StyleSpec } from '../src/config.ts'
import { CheckError } from '../src/types.ts'

const solid = (w: number, h: number, [r, g, b]: [number, number, number]) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } }).png().toBuffer()

/** CHW の 1 行（チャンネル c、行 y）の値。 */
const row = (d: Float32Array, c: number, y: number, W: number, H: number) => Array.from(d.subarray(c * W * H + y * W, c * W * H + (y + 1) * W))

/** 指定の行がすべての画素で rgb（0〜1）になっているか。 */
function rowsAre(d: Float32Array, ys: number[], rgb: number[], W: number, H: number): boolean {
  return ys.every((y) => rgb.every((v, c) => row(d, c, y, W, H).every((x) => Math.abs(x - v) < 1e-6)))
}
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
const ORANGE: [number, number, number] = [255, 128, 0]
const ORANGE01 = [1, 128 / 255, 0]
const GRAY01 = [114 / 255, 114 / 255, 114 / 255]

type Xyxy = [number, number, number, number]
/** [1, 4+nc, n] の出力。箱 j を列 j に置く（n は箱の数か 1）。 */
function yolo(nc: number, boxes: { b: Xyxy; c: number; s: number }[]) {
  const n = Math.max(boxes.length, 1)
  const data = new Float32Array((4 + nc) * n)
  boxes.forEach(({ b: [x0, y0, x1, y1], c, s }, j) => {
    data[j] = (x0 + x1) / 2
    data[n + j] = (y0 + y1) / 2
    data[2 * n + j] = x1 - x0
    data[3 * n + j] = y1 - y0
    data[(4 + c) * n + j] = s
  })
  return { dims: [1, 4 + nc, n], data }
}
const ID = { ox: 0, oy: 0, gx: 1, gy: 1 }
const xyxy = (b: Box) => [b.x0, b.y0, b.x1, b.y1]

describe('前処理', () => {
  it('(a) stretch は RGB の CHW、0〜1 で 640×640 に引き伸ばす', async () => {
    const t = await toTensor(await solid(200, 100, ORANGE), 'stretch', 640, 640)
    expect(t.data).toHaveLength(3 * 640 * 640)
    expect([t.w, t.h]).toEqual([200, 100])
    expect(rowsAre(t.data, range(0, 639), ORANGE01, 640, 640)).toBe(true)
  })

  it('分類器は 384×384 で (x − 0.5) / 0.5 にする', async () => {
    const d = await styleTensor(await solid(200, 100, ORANGE))
    expect(d).toHaveLength(3 * 384 * 384)
    expect(rowsAre(d, range(0, 383), [1, (128 / 255 - 0.5) / 0.5, -1], 384, 384)).toBe(true)
  })

  it('(b) letterbox は中央に置き、上下に 114 の行を付ける', async () => {
    const t = await toTensor(await solid(200, 100, ORANGE), 'letterbox', 640, 640)
    expect(rowsAre(t.data, range(0, 159), GRAY01, 640, 640)).toBe(true)
    expect(rowsAre(t.data, range(160, 479), ORANGE01, 640, 640)).toBe(true)
    expect(rowsAre(t.data, range(480, 639), GRAY01, 640, 640)).toBe(true)
  })

  it('(b) letterbox の奇数の余白は下を 1 多くする（100×33）', async () => {
    expect(letterboxLayout(100, 33, 640, 640)).toMatchObject({ nw: 640, nh: 211, top: 214, bottom: 215, left: 0, right: 0 })
    const t = await toTensor(await solid(100, 33, ORANGE), 'letterbox', 640, 640)
    expect(rowsAre(t.data, range(0, 213), GRAY01, 640, 640)).toBe(true)
    expect(rowsAre(t.data, range(214, 424), ORANGE01, 640, 640)).toBe(true)
    expect(rowsAre(t.data, range(425, 639), GRAY01, 640, 640)).toBe(true)
    // 横向きでも右が 1 多い
    expect(letterboxLayout(33, 100, 640, 640)).toMatchObject({ left: 214, right: 215, top: 0, bottom: 0 })
  })

  it('(c) pad は下に 0 の行を足して正方形にしてから 640 にする', async () => {
    const t = await toTensor(await solid(200, 100, ORANGE), 'pad', 640, 640)
    expect(t.data).toHaveLength(3 * 640 * 640)
    // 境目の数行は補間で混ざる
    expect(rowsAre(t.data, range(0, 317), ORANGE01, 640, 640)).toBe(true)
    expect(rowsAre(t.data, range(322, 639), [0, 0, 0], 640, 640)).toBe(true)
  })
})

describe('後処理', () => {
  it('(d) 出力は [1, 4+nc, N] として読む', () => {
    // 7×5。箱は列 2 だけ（[N, 7] と読むと別の値になる）
    const n = 5
    const data = new Float32Array(7 * n)
    data.set([0, 0, 100, 0, 0], 0) // cx
    data.set([0, 0, 200, 0, 0], n) // cy
    data.set([0, 0, 40, 0, 0], 2 * n) // w
    data.set([0, 0, 60, 0, 0], 3 * n) // h
    data.set([0, 0, 0.9, 0, 0], 5 * n) // クラス 1 のスコア
    const out = decode(data, n, ['nipple_f', 'penis', 'pussy'], 0.3, 0.7, ID, 640, 640)
    expect(out.map(xyxy)).toEqual([[80, 170, 120, 230]])
    expect(out[0]!.label).toBe('penis')
    expect(out[0]!.score).toBeCloseTo(0.9, 6)
  })

  it('(e) 方式ごとに、元の箱をモデル座標に写して戻すと同じ箱になる', () => {
    for (const mode of ['stretch', 'letterbox', 'pad'] as const) {
      const m = mapping(mode, 200, 100, 640, 640)
      const fwd = ([x0, y0, x1, y1]: Xyxy): Xyxy => [x0 * m.gx + m.ox, y0 * m.gy + m.oy, x1 * m.gx + m.ox, y1 * m.gy + m.oy]
      const o = yolo(1, [{ b: fwd([20, 10, 60, 50]), c: 0, s: 0.9 }, { b: [-50, -50, 700, 700], c: 0, s: 0.8 }])
      const out = decode(o.data, o.dims[2]!, ['x'], 0.3, 0.99, m, 200, 100)
      // はみ出す箱は、範囲に切り詰めた整数になる
      expect(out.map(xyxy), mode).toEqual([[20, 10, 60, 50], [0, 0, 200, 100]])
    }
    expect(mapping('letterbox', 200, 100, 640, 640)).toEqual({ ox: 0, oy: 160, gx: 3.2, gy: 3.2 })
  })

  it('(e) 丸めは numpy と同じく偶数へ', () => {
    expect([0.5, 1.5, 2.5, 2.4, 2.6, 3].map(roundHalfEven)).toEqual([0, 2, 2, 2, 3, 3])
    const o = yolo(1, [{ b: [20.5, 21.5, 30.5, 31.5], c: 0, s: 0.9 }])
    expect(decode(o.data, 1, ['x'], 0.3, 0.7, ID, 640, 640).map(xyxy)).toEqual([[20, 22, 30, 32]])
  })

  it('(f) NMS の重なりは +1 の規約で、IoU ≤ しきい値の箱を残す', () => {
    const a: Box = { x0: 0, y0: 0, x1: 5, y1: 5, label: 'x', score: 0.9 }
    const b: Box = { x0: 1, y0: 0, x1: 6, y1: 5, label: 'y', score: 0.8 }
    // (5·6) / (36 + 36 − 30)。+1 なしなら 20/30 = 0.667
    expect(iou(a, b)).toBeCloseTo(30 / 42, 12)
    expect(nms([b, a], 0.71)).toEqual([a])
    expect(nms([b, a], 0.72)).toEqual([a, b])
    expect(nms([b, a], 30 / 42)).toEqual([a, b])
  })

  it('(g) スコアがちょうどしきい値の箱は残らない', () => {
    // float32 の 0.3 は 0.3 よりわずかに大きい。imgutils と同じく float32 で比べる
    const just = yolo(1, [{ b: [0, 0, 10, 10], c: 0, s: 0.3 }, { b: [100, 100, 110, 110], c: 0, s: 0.5 }])
    expect(decode(just.data, 2, ['x'], 0.3, 0.7, ID, 640, 640)).toHaveLength(1)
    expect(decode(just.data, 2, ['x'], 0.5, 0.7, ID, 640, 640)).toHaveLength(0)
    const above = yolo(1, [{ b: [0, 0, 10, 10], c: 0, s: 0.30000004 }])
    expect(decode(above.data, 1, ['x'], 0.3, 0.7, ID, 640, 640)).toHaveLength(1)
  })

  it('(h) NaN・無限大・形の不一致は internal', () => {
    const ok = (d: readonly number[]) => d.length === 3 && d[1] === 7
    const kind = (t: { dims: number[]; data: unknown }) => {
      try {
        checkOutput(t, ok)
      } catch (e) {
        return e instanceof CheckError ? e.kind : 'other'
      }
      return 'none'
    }
    expect(kind({ dims: [1, 7, 1], data: new Float32Array(7) })).toBe('none')
    expect(kind({ dims: [1, 7, 1], data: new Float32Array([0, 0, 0, 0, NaN, 0, 0]) })).toBe('internal')
    expect(kind({ dims: [1, 7, 1], data: new Float32Array([0, 0, 0, 0, Infinity, 0, 0]) })).toBe('internal')
    expect(kind({ dims: [1, 8, 1], data: new Float32Array(8) })).toBe('internal')
    expect(kind({ dims: [1, 7, 2], data: new Float32Array(7) })).toBe('internal')
    expect(kind({ dims: [1, 7, 1], data: new Float64Array(7) })).toBe('internal')
  })

  it('(j) 合計が 1 の出力に softmax を二重にかけない', () => {
    expect(toProbs(new Float32Array([0.75, 0.25]))).toEqual([0.75, 0.25])
    expect(toProbs([0.97363972, 0.02636033])).toEqual([0.97363972, 0.02636033])
    const s = toProbs([2, 0])
    expect(s[0]).toBeCloseTo(Math.exp(2) / (Math.exp(2) + 1), 12)
    expect(s[0]! + s[1]!).toBeCloseTo(1, 12)
  })
})

// --- ONNX の付属情報（ModelProto の protobuf） ---
const varint = (n: number): number[] => {
  const o: number[] = []
  while (n >= 0x80) {
    o.push((n % 128) | 0x80)
    n = Math.floor(n / 128)
  }
  o.push(n)
  return o
}
const len = (field: number, body: number[]): number[] => [...varint(field * 8 + 2), ...varint(body.length), ...body]
const str = (s: string) => [...Buffer.from(s, 'utf8')]
/** ほかのフィールド（varint・LEN・fixed32・fixed64）の後ろに metadata_props を置いた ModelProto。 */
function model(meta: Record<string, string>): Buffer {
  return Buffer.from([
    ...varint(1 * 8), ...varint(8), // ir_version
    ...len(7, [0x0a, 0x03, 0x61, 0x62, 0x63]), // graph（読み飛ばす）
    ...varint(30 * 8 + 5), 1, 2, 3, 4,
    ...varint(31 * 8 + 1), 1, 2, 3, 4, 5, 6, 7, 8,
    ...Object.entries(meta).flatMap(([k, v]) => len(14, [...len(1, str(k)), ...len(2, str(v))])),
  ])
}

const ANIME_NAMES = "{0: 'nipple_f', 1: 'penis', 2: 'pussy'}"
const ERAX_NAMES = "{0: 'anus', 1: 'make_love', 2: 'nipple', 3: 'penis', 4: 'vagina'}"

describe('(i) 付属情報', () => {
  it('Python の dict の表記の names を読む', () => {
    expect(parseNames(ANIME_NAMES)).toEqual(['nipple_f', 'penis', 'pussy'])
    expect(parseNames(ERAX_NAMES)).toEqual(['anus', 'make_love', 'nipple', 'penis', 'vagina'])
    expect(parseNames('{0: "a", 1: \'it\\\'s\',}')).toEqual(['a', "it's"])
    for (const bad of ['', '{}', '[0, 1]', "{1: 'a'}", "{0: 'a', 2: 'b'}", "{0: a}", "{0: 'a' 1: 'b'}"]) {
      expect(parseNames(bad), bad).toBeUndefined()
    }
  })

  it('ModelProto の metadata_props（フィールド 14）だけを読み、ほかを読み飛ばす', () => {
    const m = readMetadata(model({ names: ANIME_NAMES, imgsz: '[640, 640]', 作者: '値' }))
    expect(Object.fromEntries(m)).toEqual({ names: ANIME_NAMES, imgsz: '[640, 640]', 作者: '値' })
    expect(readMetadata(model({})).size).toBe(0)
    const whole = model({ names: ANIME_NAMES })
    expect(() => readMetadata(whole.subarray(0, whole.length - 3))).toThrow()
  })

  it('入力の寸法は imgsz（[h, w]）、なければ 640×640', () => {
    expect(inputSize(undefined)).toEqual([640, 640])
    expect(inputSize('[640, 640]')).toEqual([640, 640])
    expect(inputSize('[480, 640]')).toEqual([480, 640])
    expect(inputSize('320')).toEqual([320, 320])
    for (const bad of ['x', '[0, 640]', '[1, 2, 3]', '"640"']) expect(() => inputSize(bad), bad).toThrow()
  })
})

// --- createDetector（偽の ORT） ---
type Out = { dims: number[]; data: Float32Array }
let dir: string
const ORT_TEXT = 'ORT_INTERNAL_TEXT'

/** 偽の onnxruntime-node。モデルは付属情報の kind で見分ける。log に作成と実行を記録する。 */
function fakeOrt(log: string[], outputs: Record<string, () => Out>, inputShape: Record<string, (number | string)[]> = {}) {
  class Tensor {
    constructor(readonly type: string, readonly data: Float32Array, readonly dims: readonly number[]) {}
  }
  return {
    models: [] as Uint8Array[],
    Tensor,
    InferenceSession: {
      async create(m: Uint8Array, opts: unknown) {
        const kind = readMetadata(m).get('kind')!
        log.push(`create:${kind}:${JSON.stringify(opts)}`)
        return {
          inputNames: ['in'],
          outputNames: ['out'],
          inputMetadata: [{ shape: inputShape[kind] ?? ['batch', 3, 'height', 'width'] }],
          async run(feeds: Record<string, Tensor>) {
            log.push(`run:${kind}:${feeds.in!.dims.join('x')}`)
            return { out: outputs[kind]!() }
          },
        }
      },
    },
  }
}

const spec = (name: string, o: Partial<DetectorSpec> = {}): DetectorSpec => ({
  model: join(dir, name), sha256: undefined, labels: undefined, classes: ['penis', 'pussy'], threshold: 0.3, resize: 'stretch', ...o,
})
const animeSpec = (o: Partial<DetectorSpec> = {}) => spec('anime.onnx', o)
const photoSpec = (o: Partial<DetectorSpec> = {}) => spec('photo.onnx', { classes: ['penis', 'vagina', 'anus'], resize: 'letterbox', ...o })
const styleSpec = (o: Partial<StyleSpec> = {}): StyleSpec => ({
  model: join(dir, 'style.onnx'), sha256: undefined, labels: ['anime', 'real'], realLo: 0.25, realHi: 0.75, ...o,
})
const cfgOf = (o: Partial<Config>) => defaultConfig({ detect: true, ...o })
const one = (o: Partial<Config> = {}) => cfgOf({ detectAnime: animeSpec(), ...o })
const two = (o: Partial<Config> = {}) => cfgOf({ detectAnime: animeSpec(), detectPhoto: photoSpec(), style: styleSpec(), ...o })

async function message(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('失敗しませんでした')
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'PATHMARK-'))
  writeFileSync(join(dir, 'anime.onnx'), model({ kind: 'anime', stride: '32', names: ANIME_NAMES }))
  writeFileSync(join(dir, 'nonames.onnx'), model({ kind: 'anime' }))
  writeFileSync(join(dir, 'badnames.onnx'), model({ kind: 'anime', names: '[nipple_f, penis]' }))
  writeFileSync(join(dir, 'photo.onnx'), model({ kind: 'photo', imgsz: '[640, 640]', names: ERAX_NAMES }))
  writeFileSync(join(dir, 'style.onnx'), model({ kind: 'style' }))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('createDetector の起動時の検査', () => {
  const zeros = { anime: () => yolo(3, []), photo: () => yolo(5, []), style: () => ({ dims: [1, 2], data: new Float32Array([0.5, 0.5]) }) }
  const fixed = (msg: string, name: string) => {
    expect(msg).toContain(name)
    expect(msg).not.toContain('PATHMARK')
    expect(msg).not.toContain(ORT_TEXT)
  }

  it('ファイルがなければ、ランタイムを読む前に止める（どのモデルでも）', async () => {
    let loads = 0
    const load = async () => {
      loads++
      throw new Error(ORT_TEXT)
    }
    fixed(await message(createDetector(one({ detectAnime: animeSpec({ model: join(dir, 'none.onnx') }) }), dir, load)), 'DETECT_ANIME_MODEL')
    fixed(await message(createDetector(two({ style: styleSpec({ model: join(dir, 'none.onnx') }) }), dir, load)), 'STYLE_MODEL')
    expect(loads).toBe(0)
  })

  it('SHA-256 が違えば、ランタイムを読む前に止める。一致すれば照合した Buffer からセッションを作る', async () => {
    let loads = 0
    const load = async () => {
      loads++
      throw new Error(ORT_TEXT)
    }
    const bad = animeSpec({ sha256: '0'.repeat(64) })
    fixed(await message(createDetector(one({ detectAnime: bad }), dir, load)), 'DETECT_ANIME_SHA256')
    fixed(await message(createDetector(two({ detectPhoto: photoSpec({ sha256: 'f'.repeat(64) }) }), dir, load)), 'DETECT_PHOTO_SHA256')
    expect(loads).toBe(0)

    const file = readFileSync(join(dir, 'anime.onnx'))
    const log: string[] = []
    const ort = fakeOrt(log, zeros)
    const create = ort.InferenceSession.create
    const seen: Uint8Array[] = []
    ort.InferenceSession.create = async (m, o) => {
      seen.push(m)
      return create(m, o)
    }
    const sha256 = createHash('sha256').update(file).digest('hex')
    await createDetector(one({ detectAnime: animeSpec({ sha256 }), detectThreads: 3 }), dir, async () => ort)
    expect(seen).toHaveLength(1)
    expect(Buffer.isBuffer(seen[0]) && Buffer.compare(seen[0], file) === 0).toBe(true)
    expect(log[0]).toBe('create:anime:{"intraOpNumThreads":3,"logSeverityLevel":3}')
  })

  it('ランタイムを読めなければ、ORT の文言を出さずに止める', async () => {
    const msg = await message(createDetector(one(), dir, async () => {
      throw new Error(`${ORT_TEXT} ${dir}`)
    }))
    fixed(msg, 'onnxruntime-node')
    fixed(await message(createDetector(one(), dir, async () => ({}))), 'onnxruntime-node')
  })

  it('セッションを作れなければ、変数名だけを示す', async () => {
    const ort = fakeOrt([], zeros)
    ort.InferenceSession.create = async () => {
      throw new Error(`${ORT_TEXT} ${join(dir, 'anime.onnx')}`)
    }
    fixed(await message(createDetector(one(), dir, async () => ort)), 'DETECT_ANIME_MODEL')
  })

  it('ラベル: names がなければ LABELS を使い、どちらもなければ止める。対象のクラスがなければ試しの推論の前に止める', async () => {
    const log: string[] = []
    const load = async () => fakeOrt(log, zeros)
    fixed(await message(createDetector(one({ detectAnime: animeSpec({ model: join(dir, 'nonames.onnx') }) }), dir, load)), 'DETECT_ANIME_LABELS')
    fixed(await message(createDetector(one({ detectAnime: animeSpec({ model: join(dir, 'badnames.onnx') }) }), dir, load)), 'DETECT_ANIME_MODEL')
    fixed(await message(createDetector(one({ detectAnime: animeSpec({ classes: ['vagina'] }) }), dir, load)), 'DETECT_ANIME_CLASSES')
    expect(log.some((l) => l.startsWith('run:'))).toBe(false)
    await createDetector(one({ detectAnime: animeSpec({ model: join(dir, 'nonames.onnx'), labels: ['nipple_f', 'penis', 'pussy'] }) }), dir, load)
    expect(log.at(-1)).toBe('run:anime:1x3x640x640')
  })

  it('試しの推論の出力の形が違えば止める（検出器 [1,4+nc,N]、分類器 [1,ラベル数]）', async () => {
    const load = (o: Partial<typeof zeros>) => async () => fakeOrt([], { ...zeros, ...o })
    fixed(await message(createDetector(one(), dir, load({ anime: () => yolo(4, []) }))), 'DETECT_ANIME_MODEL')
    fixed(await message(createDetector(one(), dir, load({ anime: () => ({ dims: [7, 1], data: new Float32Array(7) }) }))), 'DETECT_ANIME_MODEL')
    fixed(await message(createDetector(two(), dir, load({ style: () => ({ dims: [1, 3], data: new Float32Array(3) }) }))), 'STYLE_MODEL')
    fixed(await message(createDetector(two(), dir, load({ photo: () => ({ dims: [1, 9, 1], data: new Float32Array(9).fill(NaN) }) }))), 'DETECT_PHOTO_MODEL')
  })

  it('入力の形が静的で、前処理の寸法と違えば止める', async () => {
    const load = (shape: (number | string)[]) => async () => fakeOrt([], zeros, { anime: shape, photo: [1, 3, 640, 640], style: [1, 3, 384, 384] })
    fixed(await message(createDetector(one(), dir, load([1, 3, 320, 320]))), 'DETECT_ANIME_MODEL')
    fixed(await message(createDetector(one(), dir, load(['batch', 3, 'height']))), 'DETECT_ANIME_MODEL')
    await expect(createDetector(two(), dir, load(['batch', 3, 640, 'width']))).resolves.toBeTypeOf('function')
  })

  it('順序: ファイルと照合 → ランタイム → モデルごとにセッション・ラベル・試しの推論', async () => {
    const log: string[] = []
    await createDetector(two(), dir, async () => {
      log.push('load')
      return fakeOrt(log, zeros)
    })
    expect(log.map((l) => l.replace(/:\{.*\}$/u, ''))).toEqual([
      'load',
      'create:anime', 'run:anime:1x3x640x640',
      'create:photo', 'run:photo:1x3x640x640',
      'create:style', 'run:style:1x3x384x384',
    ])
  })

  it('検出器が 1 つなら分類器を読み込まない', async () => {
    const log: string[] = []
    await createDetector(one(), dir, async () => fakeOrt(log, zeros))
    expect(log.some((l) => l.includes('style'))).toBe(false)
  })
})

describe('Detector', () => {
  let png: Uint8Array
  beforeAll(async () => {
    png = await solid(640, 640, [10, 20, 30]) // 640×640 なら stretch も letterbox も恒等の写像
  })

  it('対象のクラスに絞り、スコアの高い順に DETECT_MAX_CROPS 件までにする（元の座標）', async () => {
    const out = yolo(3, [
      { b: [0, 0, 50, 50], c: 0, s: 0.99 }, // nipple_f は対象外
      { b: [100, 100, 150, 150], c: 1, s: 0.5 },
      { b: [200, 200, 250, 250], c: 2, s: 0.9 },
      { b: [300, 300, 350, 350], c: 1, s: 0.7 },
    ])
    let current = yolo(3, [])
    const det = await createDetector(one({ detectMaxCrops: 2 }), dir, async () => fakeOrt([], { anime: () => current }))
    current = out
    const boxes = await det(png)
    expect(boxes.map((b) => [b.label, ...xyxy(b)])).toEqual([['pussy', 200, 200, 250, 250], ['penis', 300, 300, 350, 350]])
    expect(boxes.every((b) => [b.x0, b.y0, b.x1, b.y1].every(Number.isInteger))).toBe(true)
  })

  it('real の確率で振り分ける（≥ HI は写真用、≤ LO はイラスト用、その間は両方）', async () => {
    const log: string[] = []
    let p = 0.5
    const det = await createDetector(two(), dir, async () => fakeOrt(log, {
      anime: () => yolo(3, []), photo: () => yolo(5, []),
      style: () => ({ dims: [1, 2], data: new Float32Array([1 - p, p]) }),
    }))
    const runs = async (v: number) => {
      p = v
      log.length = 0
      await det(png)
      return log.map((l) => l.split(':')[1])
    }
    expect(await runs(0.75)).toEqual(['style', 'photo'])
    expect(await runs(0.9)).toEqual(['style', 'photo'])
    expect(await runs(0.25)).toEqual(['style', 'anime'])
    expect(await runs(0.5)).toEqual(['style', 'anime', 'photo'])
  })

  it('両方を使うと、まとめて NMS をかけ、同点は検出器の順にする', async () => {
    let on = false
    const animeOut = () => yolo(3, on ? [{ b: [100, 100, 200, 200], c: 1, s: 0.6 }, { b: [300, 300, 350, 350], c: 2, s: 0.6 }] : [])
    const photoOut = () => yolo(5, on ? [{ b: [500, 500, 550, 550], c: 4, s: 0.6 }, { b: [102, 100, 202, 200], c: 3, s: 0.9 }] : [])
    const style = () => ({ dims: [1, 2], data: new Float32Array([0.5, 0.5]) })
    const load = async () => fakeOrt([], { anime: animeOut, photo: photoOut, style })
    const det = await createDetector(two(), dir, load)
    on = true
    // 写真用の 0.9 が重なるイラスト用の箱を消す。0.6 の同点はイラスト用が先
    expect((await det(png)).map(xyxy)).toEqual([[102, 100, 202, 200], [300, 300, 350, 350], [500, 500, 550, 550]])
    on = false
    const capped = await createDetector(two({ detectMaxCrops: 2 }), dir, load)
    on = true
    expect((await capped(png)).map(xyxy)).toEqual([[102, 100, 202, 200], [300, 300, 350, 350]])
  })

  it('(h) 推論の出力に NaN があるか形が違えば internal', async () => {
    let current: Out = yolo(3, [])
    const det = await createDetector(one(), dir, async () => fakeOrt([], { anime: () => current }))
    current = { dims: [1, 7, 1], data: new Float32Array([1, 1, 1, 1, NaN, 0, 0]) }
    await expect(det(png)).rejects.toMatchObject({ kind: 'internal' })
    current = yolo(5, [])
    await expect(det(png)).rejects.toMatchObject({ kind: 'internal' })
  })

  it('中断されていれば推論しない', async () => {
    const log: string[] = []
    const det = await createDetector(one(), dir, async () => fakeOrt(log, { anime: () => yolo(3, []) }))
    log.length = 0
    const reason = new Error('stop')
    await expect(det(png, AbortSignal.abort(reason))).rejects.toBe(reason)
    expect(log).toEqual([])
  })
})

describe('依存', () => {
  it('src のどこにも onnxruntime-node のリテラルの import がない', () => {
    const src = join(import.meta.dirname, '..', 'src')
    for (const f of readdirSync(src).filter((n) => n.endsWith('.ts'))) {
      const text = readFileSync(join(src, f), 'utf8')
      expect(/(?:from|import)\s*\(?\s*['"`]onnxruntime-(?:node|common)['"`]/u.test(text), f).toBe(false)
    }
  })
})
