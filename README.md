# mosaic-probe-harness

画像（PSD などのレイヤー付きファイルを含む）を受け取り、**「モザイク処理が必要な部位が存在しない、または十分に処理されている確率（`p_ok`）」**を `0` 〜 `1` の数値 1 個で返すローカル API サーバーです。

- **推論バックエンド**: 同一ホスト（またはローカルネットワーク）上の `llama.cpp`（`llama-server`、マルチモーダル対応 Qwen VLM）を利用します。
- **確率算出**: `llama-server` による 5 択分類（A: 対象なし / B: 処理済み / C: かけ忘れ / D: 不十分 / E: ノリ）の次トークン `logprobs` から確率を計算します。`p_ok` は従来どおりの数値で、問題の種類（かけ忘れ・不十分・ノリ）は `detail` を付けたときだけ返します。
- **呼び出し方法**: REST API（ブラウザ・Node.js などの HTTP クライアント）および MCP（Streamable HTTP）に対応しています。
- **判定の委譲**: サーバーは確率値（`p_ok`）のみを返します。しきい値に基づく OK / NG の最終判定は呼び出し側で行ってください。

> **関連ドキュメント**
> - AI エージェント向けの呼び出し仕様・注意事項: [docs/agent-usage.md](docs/agent-usage.md)
> - 実機での前提確認・ルール同期・評価・較正・複数台の手順: [docs/operations.md](docs/operations.md)
> - 設計の要点（確率の作り方、Pi の使い方、レイヤー安全）: [docs/design.md](docs/design.md)
> - クライアント実装例: [examples/browser.html](examples/browser.html) / [examples/call.mjs](examples/call.mjs)

---

## 動作要件

- **Node.js**: 22.19 以上
- **llama.cpp (`llama-server`)**: `--mmproj` を指定して VLM 推論・`logprobs` を返せるビルド

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

既定では `127.0.0.1:8790`（ループバックのみ）で起動します。環境変数の設定例は `start.sh` / `start.bat` の冒頭コメントを参照してください。

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
{"p_ok":0.12,"judgment":"forgot","confidence":0.62,"render":"モザイク名のレイヤーを非表示","classes":{"none":0.01,"ok":0.10,"forgot":0.62,"insufficient":0.20,"nori":0.07}}
```

- `p_ok`: 既定の応答と同じ値（較正済み。全描画のうち最小）。
- `judgment`: **総合判断**。`classes` の 5 択のうち、最も確率が高い答え（`none` / `ok` / `forgot` / `insufficient` / `nori`）。同率のときは重い順（`forgot` > `insufficient` > `nori` > `ok` > `none`）。
- `confidence`: **総合判断の確率**（0〜1）。`classes[judgment]` と同じ値で、較正前の生の確率。この判断が、どれくらいの確からしさで選ばれたかを示す。
- `render`: 最悪（`p_ok` が最小）の描画の説明。例: 「見えているとおり」「モザイク名のレイヤーを非表示」。
- `classes`: その最悪の描画について、モデルが出した**較正前の生の確率**（合計 1）。`none`=対象なし、`ok`=処理済み、`forgot`=かけ忘れ、`insufficient`=不十分、`nori`=ノリ。`p_ok` とは直接の換算関係がないので、`p_ok` の代わりに使わないでください。
- `judgment` と `confidence` は参考情報です。問題が 3 種類に割れていると（例: かけ忘れ 0.2・不十分 0.2・ノリ 0.2、対象なし 0.35）、問題の合計（0.6）のほうが大きくても `judgment` は `none` になり、`confidence` も低くなります。**問題があるかどうかは `p_ok` で見て、`judgment` と `confidence` は「どの種類か」と「その判断の確からしさ」を知るために使ってください。**
- 失敗時は、既定の応答と同じエラー（`{"error": …}`）だけを返し、数値も詳細も返しません。
- `detail` を付けても、判定の内容・時間は変わりません（同じ描画を判定し、結果の表示を増やすだけです）。

#### 生バイトで送信する（推奨）

ブラウザの `fetch` で `File` / `Blob` をそのまま渡す場合や、PSD ファイルを送信する場合に適しています。`Content-Type` が `application/json` 以外（`application/octet-stream` や `image/*` など）の場合は生バイトとして読み取ります。

```sh
curl -X POST http://<サーバーのIP>:8790/v1/check \
  -H "Authorization: Bearer $MOSAIC_API_KEY" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @image.psd
```

#### JSON（Base64 / Data URI）で送信する

`Content-Type: application/json` の場合は、`image_base64` フィールドに Base64 文字列または Data URI を指定します。

```sh
curl -X POST http://<サーバーのIP>:8790/v1/check \
  -H "Authorization: Bearer $MOSAIC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"image_base64":"data:image/png;base64,iVBORw0KGgo..."}'
```

### MCP: `POST /mcp`

ステートレスな Streamable HTTP（JSON 応答）エンドポイントです。HTTP リクエスト時はヘッダに `Accept: application/json, text/event-stream` を指定してください。

- **公開ツール**: `check_mosaic({ image_base64: string, detail?: boolean })`（公開するツールは `check_mosaic` の 1 つだけです）
- **成功時**: `content[0].text` に数値文字列（例: `"0.8732"`）のみを返します。`detail: true` のときは、`content[0].text` に REST の詳細応答と同じ JSON 文字列を入れます（`JSON.parse` で読めます。形式は上の「詳細を取得する」を参照）。
- **失敗時**: `isError: true` となり、`content[0].text` は `error: <種別>: <メッセージ>` で始まります（数値は含みません）。**HTTP ステータスは `200` のままなので、必ず `isError` を確認してください。**
- `initialize` やセッション ID は不要で、`tools/call` だけで呼べます。

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
| 413 | `too_large` | リクエストボディが `MAX_IMAGE_MB` 相当の上限を超過 |
| 501 | `not_implemented` | `detail` の詳細応答を実装していないビルドで `detail=1` を指定したとき（通常の構成では発生しません） |
| 415 | `unsupported` | 未対応の画像形式（HEIC・BMP・SVG・PSB・16/32bit PSD・PDF 等） |
| 500 | `internal` | サーバー内部エラー（設定ファイル読込不可など） |
| 502 | `vlm` | `llama-server` 停止・タイムアウト・応答形式不正 |
| 503 | `busy` | 実行待ちが `QUEUE_TIMEOUT_S` を超過（`Retry-After: 5` 付与） |

---

## 判定値（`p_ok`）の意味

`p_ok` は、**「モザイクが必要な部位が写っていない、または写っている部位がすべて十分に処理されている」**とモデルが判断した確率（`0` 〜 `1`、較正適用済み）です。

- **値が低いほど危険**（未処理・処理不十分である可能性が高い）ことを意味します。
- 「何未満を NG・要確認とするか」のしきい値は利用者が運用要件に合わせて決定してください（評価スクリプト `eval/run_eval.ts` が算出する推奨しきい値は参考表示用であり、サーバーには自動反映されません）。

### 問題の種類（かけ忘れ・不十分・ノリ）

`p_ok` は問題の種類を分けずに数えた値です。種類は `detail` を付けたときの `classes` に入ります（参考情報。`p_ok` が主の値です）。

| 種類 | 意味 |
|---|---|
| かけ忘れ（`forgot`） | 対象が隠されていない |
| 不十分（`insufficient`） | モザイクはあるが、範囲が小さい・粗さが足りない・薄い・ぼかしだけ |
| ノリ（`nori`） | モザイクではなく、黒い帯・黒い枠・黒い塗りで隠している |

- 既定では、3 種類すべてを「問題あり」として `p_ok` に数えます。
- 環境変数 `NORI_AS_OK=1` を設定すると、ノリを問題として数えず、処理済み（`ok`）として扱います。`p_ok` の計算がこの分だけ変わります。`detail` の `classes.nori` は、この設定にかかわらず生の値のまま返ります。

---

## 設定（環境変数・設定ファイル）

環境変数の既定値は [src/config.ts](src/config.ts) で定義されています。

### VLM・推論設定

| 変数名 | 既定値 | 説明 |
|---|---|---|
| `VLM_BASE_URL` | `http://127.0.0.1:8080` | `llama-server` のベース URL（単一台の既定） |
| `VLM_BASE_URLS` | なし | 複数台の `llama-server` のベース URL をカンマ区切りで指定。未設定なら `VLM_BASE_URL` の 1 件。末尾の `/` と `/v1` は除去、重複は除く |
| `VLM_SLOTS_PER_BACKEND` | `1` | 1 台あたりの同時実行数。`llama-server` の `--parallel` に合わせる（総スロット数 = 台数 × この値。同時リクエスト数の上限になる） |
| `VLM_MODEL` | `qwen3.8-flash-next` | `llama-server` に渡すモデル名 |
| `VLM_API_KEY` | なし | `llama-server` 側で Bearer 認証が必要な場合のみ設定 |
| `VLM_TIMEOUT_MS` | `120000` | `llama-server` 呼び出し 1 回あたりのタイムアウト（ミリ秒） |
| `VLM_EXTRA_BODY` | なし | リクエスト JSON のトップレベルにマージする追加設定（JSON オブジェクト文字列。例: `chat_template_kwargs` の上書き） |
| `CLASSIFY_TEMPERATURE` | `1` | 分類 logits を割る温度パラメータ。`1` より大きいと確率分布が滑らかになります |
| `NORI_AS_OK` | 未設定（ノリを問題とする） | `1` のとき、ノリ（黒い帯・枠で隠している）を問題として数えず、処理済みとして扱います。それ以外の値は無視されます |

### 画像・レイヤー制限

| 変数名 | 既定値 | 説明 |
|---|---|---|
| `MAX_EDGE` | `2048` | VLM 入力時の長辺最大ピクセル数（拡大はせず縮小のみ） |
| `MAX_IMAGE_MB` | `15` | 受信画像サイズの上限（MiB）。超過時はメモリに蓄積せず `413` を返却 |
| `MAX_PIXELS` | `100000000` | 画像デコード時の総画素数上限（展開爆弾対策） |
| `MAX_RENDERS` | `8` | 1 ファイルあたりのレンダリング（判定）回数の上限 |
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

### 設定ファイル

- **`rules.local.md` / `rules.md`**: モデルへ渡す判定基準プロンプト。`rules.local.md` が存在する場合は優先され、なければ公開用の `rules.md` が使われます。
- **`calibration.json`**: 評価スクリプト（`--write`）で生成される確率較正パラメータ（Platt スケーリングの `a`, `b`）。存在しない場合は恒等変換（無較正）になります。

---

## 入力形式とレイヤー安全対策

### 対応フォーマット

ファイル形式は拡張子ではなく**先頭バイト（マジックバイト）**で判定します。

- **対応**: PNG / JPEG / WebP / GIF / TIFF（`sharp` を使用。アニメ GIF や複数ページ TIFF は全ページを判定）/ PSD（`ag-psd` を使用、**8bit のみ**）
- **非対応（`415`）**: HEIC・BMP・SVG・PSB・16bit/32bit PSD・CLIP・XCF・PDF など
  - SVG は外部参照によるセキュリティリスクがあるため明示的に拒否します。

### レイヤー検査の仕組み

モザイクが別レイヤーに分かれているファイルでは、後からレイヤーを非表示・削除することでモザイクが解除できてしまうリスクがあります。これを防ぐため、レイヤー付きファイル（PSD）は以下の複数パターンの描画をすべて判定し、**最も低い（厳しい）`p_ok` を返します**。

1. **見えているとおりの状態**（PSD 内の Photoshop 合成画像 `imageData` を優先利用）
2. **非表示レイヤーもすべて表示した状態**
3. **名前が `MOSAIC_LAYER_PATTERN` に一致するレイヤーを非表示にした状態**
4. **可視レイヤーを上から 1 枚ずつ外した状態**（名前が変更されたモザイク層も検出するため）

描画数は最大 `MAX_RENDERS` 件までとし、上限で打ち切った場合はログに切り捨て件数を記録します。また、いずれか 1 件でも描画や VLM 判定に失敗した場合は、部分的な数値を返さずリクエスト全体をエラーにします。

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

- **同時実行**: 同時実行数は総スロット数（台数 × `VLM_SLOTS_PER_BACKEND`）です。既定の 1 台・スロット 1 では直列になります。処理中に届いたリクエストはキューで待機し、`QUEUE_TIMEOUT_S` を超えると `503` エラーになります。
- **複数台の振り分け**: 空きがあり実行中の少ない台へ振ります。接続失敗・5xx・タイムアウトした台は 15 秒外し、別の台で 1 回だけ再試行します。全台が外れていれば `502`（数値は返しません）。Mac Studio 2 台の構成は [docs/operations.md](docs/operations.md) を参照してください。再判定（`RECHECK=1`）は既定オフで、振り分けの対象外（台の 1 つ目だけを使います）。
- **実機要件**: 判定基準の確定、評価用データの用意、`llama-server` の起動条件（GGUF モデル / mmproj 選定）は運用者側で行います。`llama-server` が前提条件を満たしているかは [docs/operations.md](docs/operations.md) で確認してください。

---

## 開発・テスト

```sh
npm test          # Vitest によるテスト実行
npm run typecheck # TypeScript 型チェック (tsc --noEmit)
```

評価・較正の方法は [docs/operations.md](docs/operations.md)、呼び出しサンプルは [examples/](examples/) を参照してください。
