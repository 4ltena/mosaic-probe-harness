# 変更履歴

## v1.2.0（2026-11-21、未公開）

文書だけの更新です。API と判定は v1.1.0 から変わりません。

### 追加

- Mac mini 本体の状態を LAN から確認する手順（[docs/mac-mini-health.md](docs/mac-mini-health.md)）。macmini-hub の Health 画面・API の使い方と、Merak の Health 画面への登録例を載せています。README の関連ドキュメントからたどれます。

## v1.1.0（未公開）

直前の実装（パッケージ表記は `0.1.0`）からの変更です。

### REST・MCP の互換性

| 項目 | 旧版 | v1.1 |
|---|---|---|
| リクエスト | REST の `POST /v1/check` は生バイトまたは JSON の `image_base64`。MCP の `check_mosaic` は `image_base64` | 同じ。詳細指定の `detail` と `fields` も従来どおり |
| 既定の成功応答 | REST は数値、MCP は数値の文字列 | 形式は同じ。計算式が変わるため、同じ画像でもスコアは変わり得る |
| `judgment`・`classes` | `none`、`ok`、`forgot`、`insufficient`、`nori` | `ok`、`forgot`、`nori`。対象なしは `ok`、処理不足は `forgot` に含める |
| `confidence` | 5分類のうち選ばれたクラスの確率 | 3分類のうち選ばれたクラスの較正前の確率。`ok` は対象なしと処理済みの確率の合計 |
| `per_model` | なし | `detail` に追加。モデル名ごとの `none`、`processed`、`forgot`、`nori` の確率。`fields` による指定は不可 |
| MCP の `serverInfo.version` | `0.1.0` | `1.1.0` |
| GIF・WebP のアニメーション／複数ページ TIFF | 既定で先頭8フレーム・ページを検査 | GIF・WebP は1周10秒かつ100フレームまで、TIFF は100ページまで。上限内はすべて判定し、超過は REST で `413 too_large`、MCP で `isError: true` の `too_large` |
| アニメーションの `render` | `ページ i/N` | `フレーム i/N`。TIFF では `ページ i/N` |
| PSD の描画上限 | 既定8件で候補を切り捨て | 既定32件以下なら全候補を判定。超過は REST `413 too_large`、MCP ツールエラー。両方で必要件数と上限を取得可能 |
| モデルへの画像入力 | JPEG | 減色なしの8bit RGB PNG。通常判定・切り出し再判定ともに PNG を使用 |

APNG は未対応形式として扱います。REST は `415 unsupported`、MCP はツールエラーを返します。フル詳細に `fields` を併記すると `fields` が優先されます。[API 仕様](README.md#api-仕様)

### 設定と移行

- 詳細応答を使うクライアントは、型定義と表示を3分類に合わせて更新してください。
- `p_ok` は、統合後の「対象なし＋処理済み」の確率と、`forgot`・`nori` のうち大きい方の確率から計算します。既存の合否しきい値を評価データで確認してください。[判定式](docs/design.md)
- 旧 `calibration.json` は適用されません。較正を使う場合は v1.1 の評価 CLI で再生成し、評価 CSV の `insufficient` は `forgot` に移行してください。`NORI_AS_OK` を廃止しました。[評価と較正](docs/operations.md)
- `JUDGES` で複数モデルの接続先、スロット数、重みを設定できます。必要なモデルが最終的に失敗した場合、リクエスト全体が失敗します。判定バックエンドには PNG 入力と `/tokenize` の `with_pieces` に対応した `llama-server` が必要です。[動作要件と設定](README.md)
- PSD の上限を設定する `MAX_RENDERS` は2以上の安全な整数を指定します。旧設定の `1` は起動時にエラーになります。従来の上限で候補の一部だけを判定できた PSD も、v1.1 では上限超過時に判定不能になります。[PSD の検査仕様](README.md#レイヤー検査の仕組み)
