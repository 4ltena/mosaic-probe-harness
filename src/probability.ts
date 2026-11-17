// 確率の計算: 3 択の確率から p_ok を作り、較正・信頼度・閾値を扱う。
import { existsSync, readFileSync } from 'node:fs'
import type { ClassProbs, Label } from './types.ts'

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

  /** 同期読み込み。ファイルが無ければ恒等。 */
  static load(path: string): Calibrator {
    if (!existsSync(path)) return new Calibrator()
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const { a, b } = (v ?? {}) as { a?: unknown; b?: unknown }
    if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {
      throw new Error('calibration の形式が不正です')
    }
    return new Calibrator(a, b)
  }

  toJSON(): { a: number; b: number } {
    return { a: this.a, b: this.b }
  }
}

/** p_ok = 「処理不要または処理済み」の確率。低いほど危険。 */
export function pOk(probs: ClassProbs, cal: Calibrator): number {
  const total = probs.ok + probs.ng
  // 判定が一つも出ていないときは、判断材料が無いのでそのまま 1 を返す（例外にしない）
  if (total <= 0) return 1
  const q = probs.ng / total
  const pMosaicked = 1 - cal.apply(q)
  const pHasTarget = 1 - probs.none
  const pNg = pHasTarget * (1 - pMosaicked)
  return clampUnit(1 - pNg)
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
