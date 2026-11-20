// 全タスク共通の型。ここを変更するときは計画書の「共有契約」も直す。

/**
 * 判定モデルの 4 語の確率（合計 1）。語は none=対象なし / processed=処理済み / forgot=かけ忘れ・処理不足 / nori=黒い帯・枠で隠している。
 */
export interface Probs4 {
  none: number
  processed: number
  forgot: number
  nori: number
}

/** 判定器（1 モデル分）。PNG を受け、4 語の確率を返す。失敗は CheckError('vlm')。 */
export interface Judge {
  name: string
  weight: number
  judge(png: Uint8Array, signal?: AbortSignal): Promise<Probs4>
}

export interface Classes {
  ok: number
  forgot: number
  nori: number
}

/** 総合判断。4 語の判定のうち、統合後に選ばれた答え（ok = 対象なし・処理済みのどちらか）。 */
export type Judgment = 'ok' | 'forgot' | 'nori'

/** 詳細応答で選べる項目（p_ok は常に含む）。`?fields=judgment,confidence`（MCP は fields 引数）で絞る。 */
export const DETAIL_FIELDS = ['judgment', 'confidence', 'render', 'classes'] as const
export type DetailField = (typeof DETAIL_FIELDS)[number]

/** 詳細応答 `?detail=1`（MCP は detail: true）の中身。p_ok は較正済み、classes は最悪の描画の統合後の値。 */
export interface Detail {
  pOk: number
  /** 総合判断（統合後の okMass と ngMass で決まる）。 */
  judgment: Judgment
  /** 総合判断の確率（ok なら okMass、NG なら ngMass）。 */
  confidence: number
  /** 最悪（p_ok が最小）の描画の説明。例: 「見えているとおり」「モザイク名のレイヤーを非表示」。 */
  render: string
  classes: Classes
  perModel: Record<string, Probs4>
  /** DETECT=1 のときだけ。選ばれた候補の描画の、画風の分類と検出の箱。 */
  detect?: Found
}

/** 検出器の箱。座標は判定に使った描画（縮小後）の画素の整数。label はクラス名。 */
export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
  label: string
  score: number
}

/** 画風の分類（STYLE_MODEL があるときだけ）。use は使った検出器（illust・photo、間なら both）。 */
export interface Style {
  pReal: number
  use: 'illust' | 'photo' | 'both'
}

/** 1 描画分の前段の結果。width・height は箱の座標の基準の寸法。 */
export interface Found {
  style?: Style
  width: number
  height: number
  boxes: Box[]
}

/** 評価専用の 3 段階ラベル（サーバーは使わない）。 */
export type Label = 'pass' | 'hold' | 'stop'

export type CheckErrorKind = 'bad_input' | 'unsupported' | 'too_large' | 'vlm' | 'busy' | 'internal'

/** 判定の失敗。数値を返せない状態を表す。HTTP では 400/415/413/502/503/500 に対応する。 */
export class CheckError extends Error {
  readonly kind: CheckErrorKind
  constructor(kind: CheckErrorKind, message: string) {
    super(message)
    this.name = 'CheckError'
    this.kind = kind
  }
}

export class PsdRenderLimitError extends CheckError {
  readonly body: {
    error: 'too_large'
    reason: 'psd_render_limit'
    required_renders: number
    max_renders: number
    message: string
  }

  constructor(requiredRenders: number, maxRenders: number) {
    super('too_large', `PSD の検査には${requiredRenders}件の描画が必要ですが、上限は${maxRenders}件です`)
    this.body = {
      error: 'too_large',
      reason: 'psd_render_limit',
      required_renders: requiredRenders,
      max_renders: maxRenders,
      message: this.message,
    }
  }
}

export const HTTP_STATUS_OF_KIND: Record<CheckErrorKind, number> = {
  bad_input: 400,
  unsupported: 415,
  too_large: 413,
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
