// モデルの 4 語の確率を統合し、判定と p_ok を計算する。較正・閾値も扱う。
import { existsSync, readFileSync } from 'node:fs'
import type { Classes, Judgment, Label, Probs4 } from './types.ts'

// 0 や 1 のまま logit に入れると無限大になるので、わずかに内側に寄せる
const EPS = 1e-12
const clampProb = (q: number): number => Math.min(Math.max(q, EPS), 1 - EPS)
const clampUnit = (v: number): number => Math.min(Math.max(v, 0), 1)
const logit = (p: number): number => Math.log(p / (1 - p))
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x))

/** Platt 較正。sigmoid(a*logit(q)+b)。既定は恒等。 */
export class Calibrator {
  readonly a: number
  readonly b: number

  constructor(a = 1, b = 0) {
    this.a = a
    this.b = b
  }

  apply(q: number): number {
    if (this.a === 1 && this.b === 0) return q
    return sigmoid(this.a * logit(clampProb(q)) + this.b)
  }

  /** Platt 較正を Newton 法で当てはめる。ys は 0/1。 */
  static fit(qs: number[], ys: number[]): Calibrator {
    if (qs.length !== ys.length) throw new Error('qs と ys の長さが違います')
    const n = qs.length
    if (n === 0) return new Calibrator()
    const nPos = ys.filter((y) => y === 1).length
    const nNeg = n - nPos
    // 0/1 をそのまま使うと過信で発散しやすいので、Platt の平滑化ターゲットを使う
    const tPos = (nPos + 1) / (nPos + 2)
    const tNeg = 1 / (nNeg + 2)
    const pts = qs.map((q, i) => ({ x: logit(clampProb(q)), t: ys[i] === 1 ? tPos : tNeg }))
    // 原点（全て 0.5）から始める。恒等から始めると過信な点で Newton が飛ぶ
    let a = 0
    let b = 0
    for (let iter = 0; iter < 100; iter++) {
      let ga = 0
      let gb = 0
      // 微小な対角項は退化（x が全て同じ等）で行列を解けなくしないため
      let haa = 1e-9
      let hab = 0
      let hbb = 1e-9
      for (const { x, t } of pts) {
        const p = sigmoid(a * x + b)
        const d = p - t
        const w = p * (1 - p)
        ga += d * x
        gb += d
        haa += w * x * x
        hab += w * x
        hbb += w
      }
      const det = haa * hbb - hab * hab
      const da = (hbb * ga - hab * gb) / det
      const db = (haa * gb - hab * ga) / det
      a -= da
      b -= db
      if (Math.abs(da) + Math.abs(db) < 1e-10) break
    }
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('較正の当てはめに失敗しました')
    return new Calibrator(a, b)
  }

  /** 同期読み込み。ファイルが無い場合と、旧式用の較正は恒等。 */
  static load(path: string): Calibrator {
    if (!existsSync(path)) return new Calibrator()
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const { version, a, b } = (v ?? {}) as { version?: unknown; a?: unknown; b?: unknown }
    if (version === undefined && typeof a === 'number' && typeof b === 'number') return new Calibrator()
    if (version !== 'v1.1') throw new Error('calibration のバージョンが不正です')
    if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {
      throw new Error('calibration の形式が不正です')
    }
    return new Calibrator(a, b)
  }

  toJSON(): { version: 'v1.1'; a: number; b: number } {
    return { version: 'v1.1', a: this.a, b: this.b }
  }
}

/**
 * DETECT=1 のときにサーバーと評価 CLI が呼ぶ。較正が単調増加（a > 0）でないと、
 * 切り出しのどれか 1 つでも NG なら NG にする、が崩れるので止める（値は出さない）。
 */
export function assertIncreasingCalibration(cal: Calibrator): void {
  if (!(cal.a > 0)) throw new Error('DETECT=1 では較正の a が正である必要があります（calibration.json を見直してください。--write では書きません）')
}

/**
 * 閾値で 3 段階に分ける。pNg = 1 - p_ok で比べる。
 * pNg <= tOk なら pass、pNg >= tNg なら stop、その間は hold。
 */
export function label(p: number, tOk: number, tNg: number): Label {
  const pNg = 1 - p
  if (pNg <= tOk) return 'pass'
  if (pNg >= tNg) return 'stop'
  return 'hold'
}

/** 信頼度表と ECE。qs は予測確率、ys は 0/1。 */
export function reliability(
  qs: number[],
  ys: number[],
  bins = 10,
): { bins: { lo: number; hi: number; n: number; meanPred: number; freq: number }[]; ece: number } {
  if (qs.length !== ys.length) throw new Error('qs と ys の長さが違います')
  const sums = Array.from({ length: bins }, () => ({ n: 0, sumQ: 0, sumY: 0 }))
  qs.forEach((q, i) => {
    const s = sums[Math.min(bins - 1, Math.max(0, Math.floor(q * bins)))]
    if (!s) return
    s.n += 1
    s.sumQ += q
    s.sumY += ys[i] ?? 0
  })
  const total = qs.length
  let ece = 0
  const out = sums.map((s, i) => {
    const meanPred = s.n > 0 ? s.sumQ / s.n : 0
    const freq = s.n > 0 ? s.sumY / s.n : 0
    if (s.n > 0) ece += (s.n / total) * Math.abs(meanPred - freq)
    return { lo: i / bins, hi: (i + 1) / bins, n: s.n, meanPred, freq }
  })
  return { bins: out, ece }
}

// 0.1 刻みに切り捨て。浮動小数の誤差で 0.5 が 0.4999… にならないよう少し足す
const floorTenth = (x: number): number => Math.floor(x * 10 + 1e-9) / 10

/**
 * 閾値を選ぶ。引数は pNg の列（NG 画像と OK 画像）。
 * tNg は NG の最小値より 0.1 手前、tOk は OK の最大値と NG の最小値の中間（tNg より下）。
 * 戻りは [tOk, tNg]。
 */
export function chooseThresholds(ngPNg: number[], okPNg: number[]): [number, number] {
  if (ngPNg.length === 0 || okPNg.length === 0) throw new Error('閾値を選ぶサンプルが足りません')
  const ngMin = Math.min(...ngPNg)
  const okMax = Math.max(...okPNg)
  const tNg = clampUnit(floorTenth(ngMin - 0.1))
  const tOk = clampUnit(Math.min(floorTenth((okMax + ngMin) / 2), tNg - 0.1))
  return [tOk, tNg]
}

/** 重みつき平均（合計 1 に正規化）。モデル間の統合に使う。 */
export function aggregate(items: { probs: Probs4; weight: number }[]): Probs4 {
  if (items.length === 0) throw new Error('統合する判定がありません')
  const scale = items.reduce((max, item) => Math.max(max, item.weight), 0)
  const acc = { none: 0, processed: 0, forgot: 0, nori: 0 }
  for (const { probs, weight } of items) {
    if (!Number.isFinite(weight) || weight <= 0) throw new Error('重みは正の有限値である必要があります')
    for (const k of KEYS4) {
      if (!Number.isFinite(probs[k]) || probs[k] < 0 || probs[k] > 1) throw new Error('確率が不正です')
      acc[k] += (weight / scale) * probs[k]
    }
  }
  const total = KEYS4.reduce((s, k) => s + acc[k], 0)
  if (total <= 0) throw new Error('確率の合計が 0 です')
  return {
    none: acc.none / total,
    processed: acc.processed / total,
    forgot: acc.forgot / total,
    nori: acc.nori / total,
  }
}

const KEYS4 = ['none', 'processed', 'forgot', 'nori'] as const

/**
 * 統合後の 4 語の確率から判定を作る（仕様 §1）。
 * okMass = none + processed、ngMass = max(forgot, nori)、ngKind は多い方の NG 種。
 * q は較正前の NG 確率。較正を指定しなければ恒等。
 */
export function judge4(p: Probs4, cal?: Calibrator): {
  q: number
  pOk: number
  judgment: Judgment
  confidence: number
  classes: Classes
  okMass: number
  ngMass: number
} {
  const okMass = clampUnit(p.none + p.processed)
  const ngMass = Math.max(p.forgot, p.nori)
  const total = okMass + ngMass
  if (!(total > 0)) throw new Error('確率の合計が 0 です')
  const q = ngMass / total
  const ngKind: 'forgot' | 'nori' = p.forgot >= p.nori ? 'forgot' : 'nori'
  const judgment: Judgment = okMass >= ngMass ? 'ok' : ngKind
  return {
    q,
    pOk: clampUnit(1 - (cal?.apply(q) ?? q)),
    judgment,
    confidence: judgment === 'ok' ? okMass : ngMass,
    classes: { ok: okMass, forgot: p.forgot, nori: p.nori },
    okMass,
    ngMass,
  }
}
