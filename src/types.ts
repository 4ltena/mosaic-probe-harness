// 全タスク共通の型。ここを変更するときは計画書の「共有契約」も直す。

/** 3 択（A=対象なし / B=処理済み / C=未処理・不十分）の確率。合計は 1。 */
export interface ClassProbs {
  none: number
  ok: number
  ng: number
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
