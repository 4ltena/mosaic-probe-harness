# 変更履歴

## 未リリース（v1.3.0 予定）

### 新機能: 前段の画風分類・部位検出と切り出し判定（任意・既定オフ）

`DETECT=1` で、画風（写真かイラストか）に合った検出器（ONNX、`onnxruntime-node`）で部位を見つけ、その切り出しも全体と同じ判定器で判定します。全体と切り出しのうち最も悪い候補を採るため、`p_ok` は `DETECT=0` の値以下になります。切り出しが最悪のときは、`render` が「…の切り出し k」になります。`detail=1`（`fields` なし）の応答には `detect` が付き、選ばれた候補の描画の画風の分類（`style`、`p_real`）と検出の箱（`boxes`、座標の基準の `width`・`height`）を返します。既定の応答と `fields` の形は変わりません。既定（`DETECT` が空か `0`）では、検出用のモジュールも `onnxruntime-node` も読み込まず、判定は変わりません。設定は [README](README.md)、モデルの取得・変換・ライセンスの注意・判定回数の目安は [docs/operations.md](docs/operations.md) を参照してください。

- 判定回数は最悪で「描画数 ×（1 + `DETECT_MAX_CROPS`）」です（PSD の 32 描画で 160 回、GIF の 100 フレームで 500 回）。クライアントのタイムアウトと `QUEUE_TIMEOUT_S` を見直してください。
- `DETECT=1` で `--write` した `calibration.json` は `DETECT=1` 用です。`DETECT=0` に戻すときは、以前のファイルに戻すか削除してください。
- `onnxruntime-node`（1.31.1）は `optionalDependencies` です。

### 総合判断は `ok`・`ng` の 2 値に

`detail` の `judgment` は `ok` か `ng` になります（以前は `ok`・`forgot`・`nori`）。`classes` は `{"ok", "ng"}`（`ng` は `forgot` と `nori` の大きい方）、`per_model` もモデルごとの `{"ok", "ng"}` になり、4 語の確率は返しません。判定の式と `p_ok` は変わりません。`judgment` の `forgot`・`nori` や `classes.forgot` を読んでいる呼び出し側は直してください。

### ノリに白線を含める

判定モデルへの指示と公開用の `rules.md` で、ノリを「黒い・白い帯、線、枠、塗り」とし、白線や白抜きで隠したものも `nori`（NG）にしました。`rules.local.md` を使う場合は、そちらも見直してください。

### 設定ファイル `.env`

サーバーと評価 CLI は、アプリのルートの `.env` を読みます。環境変数が同じ名前なら環境変数が優先されます。例は `.env.example` です。

### 移行時の確認

- **空の値は未設定になります（全項目）。** 例として `MOSAIC_BIND=` は、以前は全インターフェースで待ち受けましたが、既定の `127.0.0.1` になります。空の値を意図して使っていた設定がないか確認してください。
- **既存の `.env` が読まれるようになります。** アプリのルートに `.env` があれば、`DETECT` が未設定でも適用されます。更新前に中身を確認してください。
- **Windows では、環境変数の名前を大文字にそろえて `.env` と重ねます。** 小文字の環境変数名も、サーバー・評価 CLI の `main()` 経由では今までどおり効きます。
- `DETECT_` や `STYLE_` で始まる未知の項目（綴りの誤り）は、`DETECT` の値に関係なく起動を止めます。検査は `.env` だけでなく OS の環境変数にも効き、大文字と小文字を区別しません（小文字の `detect` も止まります）。

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
