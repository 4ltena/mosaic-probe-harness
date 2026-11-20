# mosaic-probe-harness

<p align="center">
  <a href="https://github.com/4ltena/mosaic-probe-harness/releases/tag/v1.3.0"><strong>v1.3.0</strong></a> · <a href="CHANGELOG.md">変更履歴</a>
</p>

画像（PSD などのレイヤー付きファイルを含む）を受け取り、**「モザイク処理が必要な部位が存在しない、または十分に処理されている確率（`p_ok`）」**を `0` 〜 `1` の数値 1 個で返すローカル API サーバーです。

- **推論バックエンド**: 同一ホスト（またはローカルネットワーク）上の `llama.cpp`（`llama-server`、マルチモーダル対応 Qwen VLM）を利用します。
- **確率算出**: モデルの 4 語（`none` / `processed` / `forgot` / `nori`）の先頭トークン確率を集計し、複数モデル構成では描画ごとに重み付き平均を取ります。詳細応答の総合判断と確率は `ok`・`ng` の 2 つにまとめて返します（4 語は内部計算専用です）。
- **呼び出し方法**: REST API（ブラウザ・Node.js などの HTTP クライアント）および MCP（Streamable HTTP）に対応しています。
- **判定の委譲**: 既定の応答は確率値 `p_ok` です。しきい値に基づく OK / NG の最終判定は呼び出し側で行ってください。
- **前段の検出（任意・既定オフ）**: `DETECT=1` にすると、画風（写真かイラストか）に合った検出器で部位を見つけ、その切り出しも同じ判定器で判定して、全体と切り出しのうち最も悪い候補を採用します。API の応答形式は変わりません（[設定](#前段の画風分類部位検出と切り出し判定試験機能既定オフ)）。

> **関連ドキュメント**
> - 変更履歴・移行時の確認項目（v1.3 / v1.2 / v1.1）: [CHANGELOG.md](CHANGELOG.md)
> - Mac mini の状態確認（既存ダッシュボード・Health API）: [docs/mac-mini-health.md](docs/mac-mini-health.md)
> - AI エージェント向けの呼び出し仕様・注意事項: [docs/agent-usage.md](docs/agent-usage.md)
> - 実機での前提確認・ルール同期・評価・較正・複数台の手順: [docs/operations.md](docs/operations.md)
> - 設計の要点（確率の作り方、Pi の使い方、レイヤー安全）: [docs/design.md](docs/design.md)
> - クライアント実装例: [examples/browser.html](examples/browser.html) / [examples/call.mjs](examples/call.mjs)

## 目次

- [動作要件](#動作要件)
- [セットアップと起動](#セットアップと起動)
- [API 仕様](#api-仕様)
- [判定値（`p_ok`）の意味](#判定値p_okの意味)
- [設定（環境変数・設定ファイル）](#設定環境変数設定ファイル)
- [入力形式とレイヤー安全対策](#入力形式とレイヤー安全対策)
- [セキュリティと CORS の注意点](#セキュリティと-cors-の注意点)
- [判定基準の同期（DocBase）](#判定基準の同期docbase)
- [プライバシーとデータ取り扱い](#プライバシーとデータ取り扱い)
- [制限事項と前提](#制限事項と前提)
- [開発・テスト](#開発テスト)

---

## 動作要件

- **Node.js**: 22.19 以上
- **llama.cpp（`llama-server`）**: `--mmproj` を指定した PNG での VLM 推論、`logprobs`、`/tokenize` の `with_pieces` に対応したビルド
- **`onnxruntime-node` 1.31.1（任意）**: `DETECT=1` のときだけ必要です。`optionalDependencies` として `npm ci` で入ります（導入に失敗しても他の機能は動きます）。Windows で読み込めないときは、VC++ 再頒布可能パッケージを確かめてください。モデルファイルは別に用意します（[docs/operations.md](docs/operations.md)）。

---

## セットアップと起動

### 1. 依存パッケージのインストール

```sh
npm ci
```

### 2. `llama-server` の起動（ローカル限定）

`llama-server` は必ず**ループバック（`127.0.0.1`）のみ**で待ち受けてください。外部（LAN）へ公開するのは本ハーネスだけにします。

```sh
llama-server -m <モデル.gguf> --mmproj <mmproj.gguf> --host 127.0.0.1 --port 8080 --jinja -c 8192
```

> [!NOTE]
> `llama-server` が本ハーネスの前提（画像入力、`logprobs`、1 トークン出力など）を満たすか事前に確認するには、[docs/operations.md](docs/operations.md) の手順を実行してください。

### 3. ハーネスの起動

既定では `127.0.0.1:8790`（ループバックのみ）で起動します。設定は環境変数のほか、アプリのルートの `.env` でも指定できます（[設定ファイル `.env`](#設定ファイル-env)）。環境変数の設定例は `start.sh` / `start.bat` の冒頭コメントを参照してください。

```sh
# macOS / Linux
./start.sh

# Windows（コマンドプロンプト）
start.bat

# または npm scripts から直接起動
npm start
```

### LAN へ公開する場合

ループバック以外のアドレス（`0.0.0.0` など）で待ち受ける場合は、**`MOSAIC_API_KEY` の設定が必須**です（未設定の場合は起動を拒否します）。

**macOS / Linux:**

```sh
export MOSAIC_BIND=0.0.0.0
export MOSAIC_API_KEY=<十分に長いランダム文字列>
./start.sh
```

**Windows (PowerShell):**

```powershell
$env:MOSAIC_BIND = "0.0.0.0"
$env:MOSAIC_API_KEY = "<十分に長いランダム文字列>"
.\start.bat
```

ファイアウォール設定の注意:
- **Windows**: 受信側 PC で TCP `8790` の受信を許可してください（プロファイルは「プライベートネットワーク」のみに限定推奨）。
- **macOS**: 「システム設定 > ネットワーク > ファイアウォール」で `node` の受信接続が許可されているか確認してください。`llama-server` は `127.0.0.1` のままにし、ポートを開放しないでください。

---

## API 仕様

| エンドポイント | メソッド | 認証 | 用途 |
|---|---|---|---|
| `/v1/check` | `POST` | 必要（キー設定時） | REST API による画像判定 |
| `/mcp` | `POST` | 必要（キー設定時） | MCP（Streamable HTTP）による画像判定 |
| `/healthz` | `GET` | 不要 | ヘルスチェック（`200 ok`） |

| 送信方法 | ヘッダー | リクエストに入れる画像 |
|---|---|---|
| REST の生バイト | `Content-Type: application/octet-stream` | ファイルのバイト列を本文に直接入れる |
| REST の JSON | `Content-Type: application/json` | JSON の `image_base64` に Base64 または Data URI を入れる |
| MCP の `check_mosaic` | `Content-Type: application/json`、`Accept: application/json, text/event-stream` | ツール引数の `image_base64` に Base64 または Data URI を入れる |

1回の判定につき画像1ファイルを送ります。画像データの既定上限は **15 MiB** で、Base64 は復号後のバイト数で判定します。キーを設定したサーバーには `Authorization: Bearer <APIキー>` を付けます。

### REST: `POST /v1/check`

成功時は HTTP `200` で、レスポンスボディに**数値 1 個だけ**を返します（例: `0.8732`）。既定の応答は今までどおり数値だけです。失敗時は数値を返しません。

#### 詳細を取得する（`detail`）

問題の種類を知りたいときだけ、クエリに `detail=1`（または `detail=true`）を付けます。`detail=0` や無指定は数値 1 個の応答のままです。

```sh
curl -X POST "http://<サーバーのIP>:8790/v1/check?detail=1" \
  -H "Authorization: Bearer $MOSAIC_API_KEY" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @image.psd
```

成功時の応答（`200`、`application/json`）の例:

```json
{
  "p_ok": 0.12,
  "judgment": "ng",
  "confidence": 0.88,
  "render": "モザイク名のレイヤーを非表示",
  "classes": { "ok": 0.12, "ng": 0.88 },
  "per_model": { "default": { "ok": 0.12, "ng": 0.88 } }
}
```

- **`p_ok`**: 全描画の最小値です（較正を設定している場合は適用済み）。
- **`judgment`**: `ok` または `ng` です。`ok` の確率と NG 側の確率（かけ忘れ・処理不足とノリのうち大きい方）を比較し、同率なら `ok` を選びます（NG の種類は返しません）。
- **`confidence`**: 選ばれた `judgment` の較正前の確率です。
- **`render`**: `p_ok` が最小だった描画の名前です。
  - アニメーションでは「フレーム 4/12」のように表示します。
  - `DETECT=1` で切り出しが最悪だったときは、「見えているとおりの切り出し 2」（PSD の例）や「ラスターの切り出し 1」（ラスター画像）のように描画名に「の切り出し k」が付きます（箱の座標は `detect` に入ります）。
- **`classes`**: その描画の統合済みの確率です。`ok` は対象なしと処理済みの合計、`ng` はかけ忘れ・処理不足とノリ（黒や白の帯・線・塗りで隠したもの）のうち大きい方です。
- **`per_model`**: その描画のモデル別の `ok`・`ng` で、`classes` と同じ式でまとめた値です（キーは `JUDGES` の `name`）。
- **`detect`**（`DETECT=1` のときのみ付与）: `p_ok` が最小だった候補の描画について、画風分類と検出器が見つけた箱を返します。
  - `style`: 使用した検出器（`illust`: イラスト用 / `photo`: 写真用 / `both`: 判別できず両方）。分類器がない場合は `null`。
  - `p_real`: 写真である確率。分類器がない場合は `null`。
  - `width` / `height`: 判定に使った描画（`MAX_EDGE` などで縮小したあと）の寸法（px）。元画像に重ねる場合は、この寸法との比で拡大してください。
  - `boxes`: 検出された箱の配列。各要素は `label`（クラス名）、`score`、左上 `x0`・`y0`、右下 `x1`・`y1`（上記の寸法に基づく画素座標）を持ちます。切り出さなかった箱（描画全体と同じ範囲）も含まれます。
- 失敗時は、既定の応答と同じエラー（`{"error": …}`）だけを返し、数値も詳細も返しません。
- `detail` を付けても、判定の内容・時間は変わりません（同じ描画を判定し、結果の表示を増やすだけです）。

#### 返す項目を選ぶ（`fields`）

必要な項目だけを返させるには、`detail` の代わりに `fields` を付けます（カンマ区切り）。**`p_ok` は常に含まれます。** 総合判断まわりの 3 パターンは次のとおりです。

| 欲しいもの | クエリ | 応答 |
|---|---|---|
| 総合判断だけ | `?fields=judgment` | `{"p_ok":0.12,"judgment":"ng"}` |
| 総合判断の確率だけ | `?fields=confidence` | `{"p_ok":0.12,"confidence":0.88}` |
| 両方 | `?fields=judgment,confidence` | `{"p_ok":0.12,"judgment":"ng","confidence":0.88}` |

- 選べる項目は `judgment`、`confidence`、`render`、`classes` です（例 `?fields=render,classes`）。`per_model` と `detect` を取得するには `fields` を省略し、`detail=1` を指定します。
- 項目の並びは、指定した順に関わらず固定です（`p_ok`、`judgment`、`confidence`、`render`、`classes`）。重複は 1 つにまとめます。
- `fields` を付けると `detail` は不要です。併記した場合は `fields` が優先されます。
- **不正な指定は黙って捨てず `400`（`bad_input`）**になり、判定も行いません。空（`fields=`）、未知の項目、空の要素（`fields=judgment,`）が対象です。数値も詳細も返りません。

#### 生バイトで送信する（推奨）

ブラウザの `fetch` で `File` / `Blob` をそのまま渡す場合や、PSD ファイルを送信する場合に適しています。`Content-Type` が `application/json` 以外（`application/octet-stream` や `image/*` など）の場合は生バイトとして読み取ります。

```sh
curl -X POST http://127.0.0.1:8790/v1/check \
  -H "Authorization: Bearer $MOSAIC_API_KEY" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @image.psd
```

#### JSON（Base64 / Data URI）で送信する

`Content-Type: application/json` の場合は、`image_base64` フィールドに Base64 文字列または Data URI を指定します。

```sh
curl -X POST http://127.0.0.1:8790/v1/check \
  -H "Authorization: Bearer $MOSAIC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"image_base64":"data:image/png;base64,iVBORw0KGgo..."}'
```

### MCP: `POST /mcp`

ステートレスな Streamable HTTP（JSON 応答）エンドポイントです。HTTP リクエスト時はヘッダに `Accept: application/json, text/event-stream` を指定してください。

- **公開ツール**: `check_mosaic({ image_base64: string, detail?: boolean, fields?: string[] })`（公開するツールは `check_mosaic` の 1 つだけです）
- **成功時**: `content[0].text` に数値文字列（例: `"0.8732"`）のみを返します。`fields`（`["judgment"]` など）か `detail: true` のときは、`content[0].text` に REST の詳細応答と同じ JSON 文字列を入れます（`JSON.parse` で読めます。形式は上の「詳細を取得する」を参照）。
- **失敗時**: `isError: true` となり、`content[0].text` は `error: <種別>: <メッセージ>` で始まります（数値は含みません）。**HTTP ステータスは `200` のままなので、必ず `isError` を確認してください。**
- `initialize` やセッション ID は不要で、`tools/call` だけで呼べます。

`tools/call` の本文例です。`<PNGのBase64>` はファイルをエンコードした文字列に置き換えてください。

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "check_mosaic",
    "arguments": {
      "image_base64": "<PNGのBase64>",
      "fields": ["judgment", "confidence"]
    }
  }
}
```

> [!NOTE]
> REST の JSON 送信では `Content-Type` を小文字の `application/json` で始めてください（大文字小文字を区別します。外れると生バイト扱いになり、`415` になります）。`https://` のページから `http://` の API は、ブラウザの混在コンテンツ制限で呼べません。

### ヘルスチェック: `GET /healthz`

認証不要で `200 ok` を返します。内部設定や機密情報は含みません。

```sh
curl http://<サーバーのIP>:8790/healthz
```

### エラーレスポンス

エラー時は `{"error": "<種別>"}`（画像判定・処理系のエラーでは `message` フィールドを含む場合があります）を返します。

| HTTP | 種別 (`error`) | 発生条件・備考 |
|---|---|---|
| 400 | `bad_input` | JSON 不正、Base64 不正、画像データ破損、画素数超過など |
| 401 | `unauthorized` | API キー未指定または不一致（`WWW-Authenticate: Bearer` 付与） |
| 403 | `forbidden` | 接続元 IP が `MOSAIC_ALLOW_CIDRS` の許可範囲外 |
| 404 | `not_found` | 存在しないパス |
| 405 | `method_not_allowed` | 許可されていない HTTP メソッド |
| 413 | `too_large` | 受信サイズ、フレーム・ページ数、再生時間、または PSD の描画候補数が上限を超過 |
| 415 | `unsupported` | 未対応の画像形式（APNG・HEIC・BMP・SVG・PSB・16/32bit PSD・PDF 等） |
| 500 | `internal` | サーバー内部エラー（設定ファイル読込不可など） |
| 501 | `not_implemented` | `detail` の詳細応答を実装していないビルドで `detail=1` を指定したとき（通常の構成では発生しません） |
| 502 | `vlm` | `llama-server` 停止・タイムアウト・応答形式不正 |
| 503 | `busy` | 実行待ちが `QUEUE_TIMEOUT_S` を超過（`Retry-After: 5` 付与） |

---

## 判定値（`p_ok`）の意味

`p_ok` は、**「モザイクが必要な部位が写っていない、または写っている部位がすべて十分に処理されている」**とモデルが判断した確率（`0` 〜 `1`、較正適用済み）です。

- **値が低いほど危険**（未処理・処理不十分である可能性が高い）ことを意味します。
- 「何未満を NG・要確認とするか」のしきい値は利用者が運用要件に合わせて決定してください（評価スクリプト `eval/run_eval.ts` が算出する推奨しきい値は参考表示用であり、サーバーには自動反映されません）。

### モデルの4語と集計

| 語 | 意味 |
|---|---|
| `none` | 対象が写っていない |
| `processed` | 対象が十分に処理されている |
| `forgot` | 対象が未処理、または範囲・粗さ・濃さなどが不足して読み取れる |
| `nori` | 黒い・白い帯、線、枠、塗りで隠している（白線・白抜きも含む） |

モデルの出力を描画ごとに統合し、`okMass = P(none) + P(processed)`、`ngMass = max(P(forgot), P(nori))` を求めます。`q = ngMass / (okMass + ngMass)` を Platt 較正し、`p_ok = 1 - cal(q)` とします。[確率の設計](docs/design.md)

---

## 設定（環境変数・設定ファイル）

環境変数の既定値は [src/config.ts](src/config.ts) で定義されています。空（空白だけを含む）の値は、すべての項目で**未設定**として扱い、既定値になります（例: `MOSAIC_BIND=` は `127.0.0.1`）。

### 設定ファイル `.env`

アプリのルート（サーバーや評価 CLI を起動するディレクトリ）に `.env` を置くと、環境変数と同じ名前で設定を読みます（設定例: [.env.example](.env.example)）。

- **環境変数の優先**: 同じ名前が OS の環境変数にもあれば、**環境変数が優先**されます（空の環境変数はファイル側の値を上書きしません）。
- **ファイル形式・パス**:
  - 必ず **UTF-8（BOM なし）** で保存してください（BOM 付き UTF-8 や CP932 等だと起動を止めます）。
  - Windows のパス区切りは `/` で記述してください（例: `models/anime_det.onnx`）。
- **文字のエスケープ**: 値に `#` や空白を含む場合は、必ず単引用符（`'`）で囲んでください。囲まないと `#` 以降がコメントとして捨てられ、API キーなどが黙って短くなります（Node 24.17 の `util.parseEnv` で確認済み）。
- **秘密情報の保護**: `.env` は Git 管理外（`.gitignore` 済み）です。macOS では `chmod 600 .env` にし、Windows では利用者のみが読めるフォルダに配置してください。共有フォルダや配布物には含めないでください（API キーは環境変数でも渡せます）。
- **未知の項目の検査**: `DETECT_` や `STYLE_` で始まる未知の項目（綴りの誤り）は、`DETECT` の値に関係なく変数名を示して起動を止めます。この検査は `.env` だけでなく OS の環境変数にも適用され、大文字・小文字を区別しません（小文字の `detect` も未知の項目として止まります）。

> [!WARNING]
> `.env` はアプリのルートにあれば `DETECT` の設定に関わらず読み込まれます。旧版で `.env` を配置していた場合は、更新前に中身を確認してください（[CHANGELOG.md](CHANGELOG.md)）。

### VLM・推論設定

| 変数名 | 既定値 | 説明 |
|---|---|---|
| `VLM_BASE_URL` | `http://127.0.0.1:8080` | `llama-server` のベース URL（単一台の既定） |
| `VLM_BASE_URLS` | なし | 複数台の `llama-server` のベース URL をカンマ区切りで指定。未設定なら `VLM_BASE_URL` の 1 件。末尾の `/` と `/v1` は除去、重複は除く |
| `VLM_SLOTS_PER_BACKEND` | `1` | 1 台あたりの同時実行数。`llama-server` の `--parallel` に合わせる（総スロット数 = 台数 × この値。同時リクエスト数の上限になる） |
| `JUDGES` | 未設定 | モデル別の設定を JSON 配列で指定。各要素は `{name, model, urls, slots, weight}` で、`slots` と `weight` の既定値は `1`。未設定時は `VLM_BASE_URL` または `VLM_BASE_URLS` の1モデル構成を使用 |
| `VLM_MODEL` | `qwen3.8-flash-next` | `llama-server` に渡すモデル名 |
| `VLM_API_KEY` | なし | `llama-server` 側で Bearer 認証が必要な場合のみ設定 |
| `VLM_TIMEOUT_MS` | `120000` | `llama-server` 呼び出し 1 回あたりのタイムアウト（ミリ秒） |
| `VLM_EXTRA_BODY` | なし | リクエスト JSON のトップレベルにマージする追加設定（JSON オブジェクト文字列。例 `{"top_k":20}`。分類に使う出力形式と `enable_thinking: false` は固定） |
| `CLASSIFY_TEMPERATURE` | `1` | 分類 logits を割る温度パラメータ。`1` より大きいと確率分布が滑らかになります |

### 画像・レイヤー制限

| 変数名 | 既定値 | 説明 |
|---|---|---|
| `MAX_EDGE` | `2048` | VLM 入力時の長辺最大ピクセル数（拡大はせず縮小のみ） |
| `MAX_IMAGE_MB` | `15` | 受信画像サイズの上限（MiB）。超過時はメモリに蓄積せず `413` を返却 |
| `MAX_PIXELS` | `100000000` | 画像デコード時の総画素数上限（展開爆弾対策） |
| `MAX_RENDERS` | `32` | PSD の描画候補数の上限。2以上の安全な整数 |
| `MAX_FRAMES` | `100` | GIF・WebP のフレーム数と TIFF のページ数の上限。超過は `413` |
| `MAX_ANIM_SECONDS` | `10` | GIF・WebP の1周分の再生時間上限（秒）。超過は `413` |
| `MOSAIC_LAYER_PATTERN` | `モザイク\|mosaic\|pixel\|ぼかし\|blur\|censor\|修正\|規制` | モザイク層とみなすレイヤー名の正規表現（大文字・小文字を区別しない） |

### サーバー公開・セキュリティ

| 変数名 | 既定値 | 説明 |
|---|---|---|
| `MOSAIC_BIND` | `127.0.0.1` | 待受 IP アドレス。ループバック以外は `MOSAIC_API_KEY` が必須 |
| `MOSAIC_PORT` | `8790` | 待受ポート番号 |
| `MOSAIC_API_KEY` | なし | Bearer 認証用 API キー。ループバック以外で待ち受ける場合は必須 |
| `MOSAIC_CORS_ORIGINS` | キーあり: `*` / キーなし: 許可なし | `*` または許可する Origin のカンマ区切りリスト |
| `MOSAIC_ALLOW_CIDRS` | `127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` | 接続を許可する送信元 IP の CIDR リスト |
| `QUEUE_TIMEOUT_S` | `60` | 同時実行待ちの上限時間（秒）。超過すると `503` |

### 再判定オプション（試験機能・既定オフ）

| 変数名 | 既定値 | 説明 |
|---|---|---|
| `RECHECK` | `0` | `1` を指定すると、境界付近のスコアに対し Pi エージェントによる領域切り出し（`crop`）再判定を有効化 |
| `RECHECK_LO` / `RECHECK_HI` | `0.2` / `0.9` | 再判定を発動する `p_ok` の下限 / 上限 |
| `RECHECK_MAX_CROPS` | `3` | 1 枚の画像に対して再判定で切り出す領域数の上限 |

### 前段の画風分類・部位検出と切り出し判定（試験機能・既定オフ）

- **無効時（`DETECT` が空または `0`）**: 下表の項目は値を検査せず（未知の変数名の検査のみ実施）、`onnxruntime-node` もモデルも読み込みません。
- **有効化の条件（`DETECT=1`）**:
  - 検出器（`DETECT_ANIME_MODEL` または `DETECT_PHOTO_MODEL`）が 1 つ以上必要です。
  - 検出器が 2 つの場合は `STYLE_MODEL` が必須、1 つの場合は `STYLE_MODEL` を設定してはいけません。
- **エラー時の挙動**: 不正な値が設定されている場合は、変数名だけを示して起動を止めます（値は表示しません）。
- **モデル入手と SHA-256**: 詳細は [docs/operations.md](docs/operations.md) を参照してください。

| 変数名 | 既定値 | 範囲・説明 |
|---|---|---|
| `DETECT` | なし | 空・`0`・`1`。`1` で有効。それ以外は起動を止める |
| `DETECT_ANIME_MODEL` | なし | イラスト用の検出器（ONNX）。アプリのルートからの相対パスか絶対パス |
| `DETECT_ANIME_SHA256` | なし | 64 桁の 16 進数。設定すると起動時にモデルファイルと照合 |
| `DETECT_ANIME_LABELS` | なし | クラス名のカンマ区切り。ONNX の付属情報 `names` がないときに使用 |
| `DETECT_ANIME_CLASSES` | `penis,pussy` | イラスト用の検出対象クラス。空でなく、重複なし |
| `DETECT_ANIME_THRESHOLD` | `0.3` | イラスト用のスコアしきい値。`0 < x ≤ 1`（しきい値ちょうどは残らない） |
| `DETECT_ANIME_RESIZE` | `stretch` | イラスト用の前処理。`stretch`・`letterbox`・`pad` |
| `DETECT_PHOTO_MODEL` / `_SHA256` / `_LABELS` | なし | 写真用の検出器（ONNX）。指定方法は `DETECT_ANIME_*` と同じ形式 |
| `DETECT_PHOTO_CLASSES` | `penis,vagina,anus` | 写真用の検出対象クラス。空でなく、重複なし |
| `DETECT_PHOTO_THRESHOLD` | `0.3` | 写真用のスコアしきい値。`0 < x ≤ 1`（しきい値ちょうどは残らない） |
| `DETECT_PHOTO_RESIZE` | `letterbox` | 写真用の前処理。`stretch`・`letterbox`・`pad` |
| `STYLE_MODEL` | なし | 画風の分類器（ONNX）。検出器が 2 つのときだけ設定する |
| `STYLE_SHA256` | なし | 64 桁の 16 進数。設定すると起動時にモデルファイルと照合 |
| `STYLE_LABELS` | `anime,real` | 出力の並び順のラベル。`real` を含む |
| `STYLE_REAL_LO` / `STYLE_REAL_HI` | `0.2` / `0.8` | 振り分けの境目（`0 ≤ LO < HI ≤ 1`）。`real` 確率が `HI` 以上で写真用、`LO` 以下でイラスト用、その間なら両方を使用 |
| `DETECT_MAX_CROPS` | `4` | 描画ごとの切り出しの上限。1〜32 の整数 |
| `DETECT_MARGIN` | `0.5` | 箱を各辺へ広げる割合（幅・高さに対する倍率）。0〜4 |
| `DETECT_MIN_SIDE` | `256` | 切り出しの最小の短辺（px）。1 以上で `MAX_EDGE` 以下の整数 |
| `DETECT_IOU` | `0.7` | 箱の重なりを除く NMS の IoU。`0 < x ≤ 1` |
| `DETECT_THREADS` | `2` | ONNX の intra-op スレッド数。1〜64 の整数 |

- **較正の制約**: 有効時は、較正の傾き `a` が `0` より大きいことも求めます（`a ≤ 0` なら起動を止めます。評価 CLI の `--write` も同様です）。
- **再判定（`RECHECK`）との併用**: 切り出しは再判定に回さず、再判定は全体の最悪の描画に対してのみ実行します。最終の `p_ok` は「再判定後の全体の結果」と「切り出しの最悪」のうち低い方となり、同じ入力の `DETECT=0` の値以下になります。
- **起動ログ**: 起動時に「`前段の検出: 有効（検出器 n、分類器あり/なし）`」を 1 行出力します（パスと設定値は出しません）。
- **処理回数とタイムアウト**: 判定回数は最悪で「描画数 ×（`1 + DETECT_MAX_CROPS`）」回になります。クライアントのタイムアウトと `QUEUE_TIMEOUT_S` を見直してください（[docs/operations.md](docs/operations.md)）。
- **ライセンス確認**: 3 つのモデルのライセンスは、組み込み先の法務で確認してください（[docs/operations.md](docs/operations.md#86-ライセンスの注意)）。

### その他の設定ファイル（プロンプト・較正）

- **`rules.local.md` / `rules.md`**: モデルへ渡す判定基準プロンプト。`rules.local.md` が存在する場合は優先され、なければ公開用の `rules.md` が使われます。
- **`.env`**: 上記「[設定ファイル `.env`](#設定ファイル-env)」を参照（Git 管理外）。
- **`calibration.json`**: 評価スクリプト（`--write`）で生成される確率較正パラメータ（`version: "v1.1"` と Platt スケーリングの `a`, `b`）。未生成時や旧式のファイルがある場合は恒等変換を使います。`DETECT=1` のときに `--write` で生成したファイルは `DETECT=1` 専用です（戻し方は [docs/operations.md](docs/operations.md#85-回復と較正の写し)）。

---

## 入力形式とレイヤー安全対策

### 対応フォーマット

ファイル形式の判定には**ファイルの先頭バイト（マジックバイト）**を使います。

| 形式 | 検査内容と既定上限 |
|---|---|
| PNG・JPEG | 静止画1枚を判定 |
| GIF・WebP | 静止画は1枚。アニメーションは1周10秒以下かつ100フレーム以下なら全フレームを判定 |
| TIFF | 100ページ以下なら全ページを判定。再生時間の上限は適用外 |
| PSD（8bit） | レイヤー構成を保持した原本を送信。候補が既定32件以下なら全件を判定 |

APNG・AVIF・HEIC・BMP・SVG・PSB・16/32bit PSD・CLIP・XCF・PDF などは未対応です。REST は `415 unsupported`、MCP は `unsupported` のツールエラーを返します。

モデルには各描画を**減色なしの8bit RGB PNG**として送ります。向きを整え、長辺の上限を超える画像は縮小し、透過は白に合成します。切り出し再判定も PNG を使います。PSD やアニメーションは原本のまま API に送ってください。

### アニメーションの上限

GIF・WebP は既定で **10秒以下、合計100フレーム以下**です。1周分のフレーム遅延を合計し、0 以下の遅延は 10 ms として数えます。上限内は全フレームを判定して最小値を採用します。上限を超えると、REST は `413`、MCP は `isError: true` の `too_large` を返します。TIFF はページ数の上限だけを適用します。

1フレームあたり約2.5秒で直列処理する構成では、100フレームで約4分かかります。クライアントのタイムアウトは5分以上を目安にし、モデルの速度と並列数に合わせて調整してください。

### レイヤー検査の仕組み

モザイクが別レイヤーに分かれているファイルでは、後からレイヤーを非表示・削除することでモザイクが解除できてしまうリスクがあります。これを防ぐため、レイヤー付きファイル（PSD）は以下の複数パターンの描画をすべて判定し、**最も低い（厳しい）`p_ok` を返します**。

1. **見えているとおりの状態**（PSD 内の Photoshop 合成画像 `imageData` を優先利用）
2. **非表示レイヤーもすべて表示した状態**
3. **名前が `MOSAIC_LAYER_PATTERN` に一致するレイヤーを非表示にした状態**
4. **可視レイヤーを上から 1 枚ずつ外した状態**（名前が変更されたモザイク層も検出するため）

PSD ごとに候補数を数え、上限内なら全件を判定します。上限は既定32件で、管理者が `MAX_RENDERS` で変更できます。最初の3候補がそろう場合、既定値では可視レイヤーを1枚ずつ外す検査を29件まで実行できます。

上限を超えた場合は、画像の合成・モデル判定に進まずエラーを返します。REST は `413`、MCP は `isError: true` とし、REST の本文と MCP の `structuredContent` に次の情報を含めます。

```json
{
  "error": "too_large",
  "reason": "psd_render_limit",
  "required_renders": 62,
  "max_renders": 32,
  "message": "PSD の検査には62件の描画が必要ですが、上限は32件です"
}
```

描画やモデル判定に失敗した場合も、リクエスト全体をエラーにします。

#### 前段の検出有効時（`DETECT=1`）の切り出し仕様

`DETECT=1` では、各描画の全体に加えて、検出した部位の切り出し（最大 `DETECT_MAX_CROPS` 件）も同じ判定器で判定し、全描画の全体と切り出しのうち**最も低い `p_ok`** を返します。

- **切り出し範囲**: 検出箱を `DETECT_MARGIN` の割合で広げ、短辺が `DETECT_MIN_SIDE` 未満の場合は中心を保ったまま軸ごとに広げます（拡大・縮小はせず PNG で切り出します）。
- **境界の補正**: 範囲が画像の外へ出る場合は、大きさを保ったまま画像の内側へずらします（画像より大きい場合は画像全体とします）。範囲が描画全体と同じになる切り出しは判定対象から除きます。
- **エラー時の扱い**: 検出・切り出し・切り出し判定のいずれかが失敗した場合は、リクエスト全体をエラーにします（検出・切り出しの失敗は `500 internal`、切り出し判定の失敗は `502 vlm`）。

### PSD 合成の制限事項

本ハーネスの自前レイヤー合成は `normal` ブレンドのアルファ合成のみに対応しており、Photoshop の描画結果とは完全には一致しません。以下は検出・再現できないためご注意ください。

- 2 枚以上のレイヤーにまたがって構成されたモザイク
- スマートフィルター
- レイヤー効果（ドロップシャドウ等）
- `normal` 以外のブレンドモード
- クリッピングマスクおよび塗りの不透明度（`fillOpacity`）

---

## セキュリティと CORS の注意点

- **IP 制限の仕組み**: 接続元 IP は `socket.remoteAddress` のみで判定し、`X-Forwarded-For` ヘッダは信頼しません。**前段にリバースプロキシを置かないでください**。
- **CORS プリフライト**: `OPTIONS` リクエストは認証チェックの前に `204` で応答し、必要に応じて `Access-Control-Allow-Private-Network: true` も返します。非許可 Origin には CORS ヘッダを付与しません。
- **ブラウザ利用時のキー露出**: ブラウザ上の JavaScript に `MOSAIC_API_KEY` を埋め込むと、そのページを閲覧できる全員にキーが露出します。LAN 内の信頼できるユーザー限定で運用してください。[examples/browser.html](examples/browser.html) はキーをコードに埋め込まず、画面上の入力欄から受け取る設計になっています。
- **`file://` での制限**: HTML ファイルをブラウザで直接（`file://`）開くと Origin が `null` になり CORS で失敗します。`examples/browser.html` 等を使う場合は `python3 -m http.server` 等で配信し、その Origin（例: `http://127.0.0.1:8000`）を `MOSAIC_CORS_ORIGINS` に含めるか、`MOSAIC_API_KEY` を設定して `*` を許可してください。

---

## 判定基準の同期（DocBase）

社内などの DocBase で管理している詳細な判定基準を反映したい場合は、以下の手順でローカル専用の `rules.local.md` を作成します（`docbase.json`・`rules/docbase/`・`rules.local.md` はいずれも Git 管理外です）。

1. ルートディレクトリに `docbase.json` を作成します。
   ```json
   { "team": "<チーム名>", "postIds": ["<投稿ID>", "..."] }
   ```
2. 環境変数 `DOCBASE_TOKEN` を設定して同期スクリプトを実行します。
   ```sh
   DOCBASE_TOKEN=<トークン> npx tsx scripts/sync-rules.ts
   ```
   取得した記事は `rules/docbase/` に保存されます（トークン自体はファイルにもログにも出力されません）。
3. 取得した内容を基に `rules.local.md` を作成・調整します。

詳しい運用・チューニング手順は [docs/operations.md](docs/operations.md) を参照してください。

---

## プライバシーとデータ取り扱い

- **画像非保存**: 送信された画像はメモリ上でのみ処理し、ディスクへは一切保存しません。
- **機密情報の非出力**: ログおよびエラー応答には、画像本体・Base64 文字列・API キーを出力しません。アクセスログに記録するのは、HTTP メソッド・パス・ステータスコード・所要時間・画像データの SHA-256 先頭 12 桁・バイトサイズのみです。

---

## 制限事項と前提

- **同時実行**: リクエストの同時実行上限は、各モデルの「接続先数 × 1 台あたりのスロット数」の合計です。既定の 1 台・1 スロットでは直列処理になります。空きがなく待機し、`QUEUE_TIMEOUT_S` を超えると `503` エラーになります。
- **複数台の振り分け**: 各モデルの接続先プールで空きスロットに配分します。複製のうち失敗した台は 15 秒間プールから外し、同じモデルの別の台で 1 回だけ再試行します。どれか 1 モデルでも最終的に失敗すると `502` を返します。再判定では最初の接続先に領域を提案させ、切り出し後の判定を全モデルで行います（[複数台の運用](docs/operations.md#7-複数台任意)）。
- **実機要件**: 判定基準の確定、評価用データの用意、`llama-server` の起動条件（GGUF モデル / mmproj 選定）は運用者側で行います。`llama-server` が前提条件を満たしているかは [docs/operations.md](docs/operations.md#2-動作前提の確認スパイク) で確認してください。

---

## 開発・テスト

```sh
npm test          # Vitest によるテスト実行
npm run typecheck # TypeScript 型チェック (tsc --noEmit)
```

評価・較正の方法は [docs/operations.md](docs/operations.md)、呼び出しサンプルは [examples/](examples/) を参照してください。
