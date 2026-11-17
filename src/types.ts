// 全タスク共通の型。ここを変更するときは計画書の「共有契約」も直す。

/** 問題の 3 種類。forgot=かけ忘れ（対象が隠されていない）/ insufficient=不十分（モザイクはあるが範囲・粗さ・濃さが足りない）/ nori=ノリ（モザイクではなく黒い帯・枠で隠している）。 */
export interface Kinds {
  forgot: number
  insufficient: number
  nori: number
}

/**
 * 判定の確率。合計は 1。none=対象なし / ok=処理済み / ng=問題あり。
 * `kinds` があるとき、ng は kinds の 3 つの合計に等しい（NORI_AS_OK=1 のときは nori を ok に移した後の値）。
 */
export interface ClassProbs {
  none: number
  ok: number
  ng: number
  /** 問題の種類の内訳（モデルが 5 択で答えたときだけ。nori の移動前の生の値）。 */
  kinds?: Kinds
}

/** 総合判断。5 択（none=対象なし / ok=処理済み / forgot=かけ忘れ / insufficient=不十分 / nori=ノリ）のうち、最も確率が高い答え。 */
export type Judgment = 'none' | 'ok' | 'forgot' | 'insufficient' | 'nori'

/** 詳細応答 `?detail=1`（MCP は detail: true）の中身。p_ok は較正済み、classes は最悪の描画の生の確率。 */
export interface Detail {
  pOk: number
  /** 総合判断（最悪の描画の classes のうち最も確率が高い答え。同率なら重い順 forgot > insufficient > nori > ok > none）。 */
  judgment: Judgment
  /** 総合判断の確率（classes[judgment]。較正前の生の値）。この判断がどれくらいの確からしさで選ばれたか。 */
  confidence: number
  /** 最悪（p_ok が最小）の描画の説明。例: 「見えているとおり」「モザイク名のレイヤーを非表示」。 */
  render: string
  classes: { none: number; ok: number } & Kinds
}

/** 評価専用の 3 段階ラベル（サーバーは使わない）。 */
export type Label = 'pass' | 'hold' | 'stop'

export type CheckErrorKind = 'bad_input' | 'unsupported' | 'vlm' | 'busy' | 'internal'

/** 判定の失敗。数値を返せない状態を表す。HTTP では 400/415/502/503/500 に対応する。 */
export class CheckError extends Error {
  readonly kind: CheckErrorKind
  constructor(kind: CheckErrorKind, message: string) {
    super(message)
    this.name = 'CheckError'
    this.kind = kind
  }
}

export const HTTP_STATUS_OF_KIND: Record<CheckErrorKind, number> = {
  bad_input: 400,
  unsupported: 415,
  vlm: 502,
  busy: 503,
  internal: 500,
}

/** HTTP 層の失敗（認証・サイズ・許可外 IP など）。 */
export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}
