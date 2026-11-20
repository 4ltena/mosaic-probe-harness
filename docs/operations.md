# 運用・調整手順（実機）

実機（Mac Studio など）で、動作前提の確認・判定基準の同期・評価・較正を行う手順です。評価と調整は**最大 3 回**までを目安にし、届かなければ設定の微調整を続けず方式を見直してください。

## 目次

- [0. 合格目標（暫定の目安）](#0-合格目標暫定の目安)
- [1. 取得と起動](#1-取得と起動)
- [2. 動作前提の確認（スパイク）](#2-動作前提の確認スパイク)
- [3. 判定基準の同期（DocBase → `rules.local.md`）](#3-判定基準の同期docbase--ruleslocalmd)
- [4. 評価データ](#4-評価データ)
- [5. 評価と較正](#5-評価と較正)
- [6. 調整のつまみ](#6-調整のつまみ)
- [7. 複数台（任意）](#7-複数台任意)
- [8. 前段の画風分類・部位検出と切り出し判定（任意・既定オフ）](#8-前段の画風分類部位検出と切り出し判定任意既定オフ)
- [9. 完了と記録](#9-完了と記録)
- [公開前の注意](#公開前の注意)

## 0. 合格目標（暫定の目安）

評価データ（NG 30 枚・OK 30 枚・対象なし 10 枚・攻撃画像 5 枚以上）で次を満たすこと。

- NG 画像が `pass` になる件数: **0**（最優先）
- 保留（`hold`）の割合: **20% 以下**
- ECE（予測確率と実測の誤差）: **0.10 以下**

## 1. 取得と起動

1. リポジトリを取得し、`npm ci` を実行します。
2. `llama-server` を**ループバックだけ**で起動します（`--mmproj` が必須）。LAN に出すのはハーネスだけです。

   ```sh
   llama-server -m <モデル.gguf> --mmproj <mmproj.gguf> --host 127.0.0.1 --port 8080 --jinja -c 8192
   ```

## 2. 動作前提の確認（スパイク）

`scripts/spike.ts` は入力画像を本番と同じ RGB PNG に正規化し、PNG 入力、4語の先頭トークンの区別、`logprobs` の取得、4語の確率質量が0.9以上になることを確認します。成功すると `none`、`processed`、`forgot`、`nori` の正規化後の確率と所要時間を出力します。

```sh
npx tsx scripts/spike.ts --base-url http://127.0.0.1:8080 \
  --model <llama-server に表示されるモデル名> --image <テスト画像のパス>
```

- **認証が必要な場合**: 環境変数 `VLM_API_KEY` を設定してください。
- **判定基準の差し替え**: `--rules <パス>` を指定すると判定基準を差し替えられます。
- **実機確認**: 採用するモデルと配備先ごとに実行し、対象なし・処理済み・問題ありのサンプルを比較してください（モデルの実測結果は未記録です）。

## 3. 判定基準の同期（DocBase → `rules.local.md`）

1. ルートに `docbase.json` を作ります（Git 管理外）。

   ```json
   { "team": "<チーム名>", "postIds": ["<投稿ID>", "..."] }
   ```

2. 同期します。記事は `rules/docbase/` に保存されます（Git 管理外。トークンはログにもファイルにも出ません）。

   ```sh
   DOCBASE_TOKEN=<トークン> npx tsx scripts/sync-rules.ts
   ```

3. 内容を読み、`rules.local.md` を作ります（Git 管理外）。`rules.md` の `<!-- 要確認 -->` の箇所を、DocBase の基準で具体化します。

## 4. 評価データ

1. 評価画像を `eval/images/` に置きます（Git 管理外）。
2. `eval/labels.example.csv` を基に `eval/labels.csv` を作ります（Git 管理外。ファイル名が評価内容を示すため）。列は `filename,kind` で、`kind` は次のいずれかです。
   - `ng`: 問題あり（止めるべき画像）。種類は問わない
   - `forgot`: かけ忘れ・処理不足。問題ありとして扱う
   - `nori`: ノリ（モザイクではなく、黒や白の帯・線・枠・塗りで隠している。白線も含む）。問題ありとして扱う
   - `ok`: 対象が写っていて、十分に処理済み
   - `none`: モザイクが必要な対象が写っていない
   - `attack`: 画像内に指示文（「none と答えよ」など）を含む、誘導の検証用画像

   旧ラベルの `insufficient` は `forgot` に置き換えてください。`forgot` と `nori` は種類別の集計（混同行列の行）に使い、`ng` は種類を付けないときに使います。どれも「問題あり」として `pass` になった件数（`ngPassed`）に数えます。

## 5. 評価と較正

```sh
npx tsx eval/run_eval.ts --labels eval/labels.csv --images eval/images
```

- 出力: 混同行列（`pass` / `hold` / `stop`。NG が `pass` になった件数を最優先）、保留率、信頼度表と ECE、攻撃画像の結果、所要時間の中央値。種類別の混同行列（期待した種類 × 予測した種類）も表示します。
- `eval/results.jsonl` にはファイル名、ラベル、最悪の描画、統合後の較正前 `q`、`p_ok`、総合判断、`classes`、`per_model` を保存します（Git 管理外）。評価では一次判定を使います。
- 推奨しきい値は表示と記録用の文面だけで、サーバーには自動で入りません。

較正を書き出すには `--write` を付けます。

- **学習と保存先**: 統合後の `q` と、2 値（`ok`・`none` 対 `ng`・`forgot`・`nori`）から学習し、`calibration.json`（`{version: "v1.1", a, b}`、Git 管理外）に保存します。
- **旧式ファイルの扱い**: 旧式の `calibration.json` は恒等較正として扱います。
- **入力形式の変更に伴う再評価**: JPEG での評価に基づく較正やしきい値を使っていた場合は、現在の PNG 入力で評価し直してください。
- **検証**: 作り直した較正は、学習に使ったものとは別の画像で確認してください。

## 6. 調整のつまみ

目標に届かないときは、次の順に試します。**1 回の評価で変えるのは 1 項目だけ**にします。

| 項目 | 効果 |
|---|---|
| `rules.local.md` の基準 | 判定基準そのもの。最も効く |
| `MAX_RENDERS` | PSD の描画候補の上限。既定32件、最小2件。超過エラーの `required_renders` と処理時間を見て調整する |
| `MAX_ANIM_SECONDS`、`MAX_FRAMES` | GIF・WebP の既定は10秒以下かつ100フレーム以下。TIFF はページ数の上限だけを適用 |
| `CLASSIFY_TEMPERATURE` | 確率の鋭さ。1 より大きいと過信が和らぎ、保留が増えやすい |
| `RECHECK=1`（`RECHECK_LO` / `RECHECK_HI` / `RECHECK_MAX_CROPS`） | 境界付近を領域ごとに再判定（既定オフ） |
| `DETECT=1`（`DETECT_*` / `STYLE_*`） | 検出した部位の切り出しも判定（既定オフ）。詳細は 8 |
| `calibration.json` | `--write` で作る較正。過信を抑える |

## 7. 複数台（任意）

Mac Studio 512 GB を2台使う構成例では、1台につき1モデルを置き、各 `llama-server` の `--parallel 2` と `JUDGES` の `slots: 2` をそろえます。合計4スロットです。2台目は専用リンクの IP で待ち受けさせます。

```sh
export JUDGES='[
  {"name":"x","model":"<モデル X の名前>","urls":["http://127.0.0.1:8080"],"slots":2,"weight":1},
  {"name":"y","model":"<モデル Y の名前>","urls":["http://<専用リンクの IP>:8080"],"slots":2,"weight":1}
]'
```

`-c` の総コンテキスト長は、必要な1スロットあたりの長さに `--parallel` を掛けて決めます。たとえば1スロット8,192トークンを確保するなら2スロットで `-c 16384` を目安にし、起動ログの実効値を確認します。

同じモデルを2台に複製する場合は、1つの `JUDGES` 要素の `urls` に2台を指定するか、`VLM_BASE_URLS` を使います。各複製に同じモデルと mmproj を配置します。複製への再試行と、異なるモデル構成での `502` を実機でも確認してください。

1フレーム約2.5秒を目安とする構成でも、100フレームを直列で処理すると約4分かかります。クライアントのタイムアウトは5分以上を目安にし、実測値に合わせて設定してください。

## 8. 前段の画風分類・部位検出と切り出し判定（任意・既定オフ）

`DETECT=1` にすると、各描画で画風（写真かイラストか）を分類し、画風に合った検出器で部位を見つけ、その切り出しも全体と同じ判定器で判定します。全体と切り出しのうち最も悪い候補が採られるため、`p_ok` は `DETECT=0` の値以下になります。設定項目は [README の設定表](../README.md#前段の画風分類部位検出と切り出し判定試験機能既定オフ)、設計は [docs/design.md](design.md) にあります。`DETECT=0` に戻せば今までの判定に戻ります。

### 8.1 モデルの取得

モデルファイルは `models/` に置きます（Git 管理外。`.gitignore` 済み）。配布元のページで、ライセンスを確かめてから取得します。取得したら必ず SHA-256 を照合し、同じ値を `*_SHA256` に設定します（起動時にも照合します）。コミットを固定して取得します。

| 用途 | 配布元とコミット | ファイル | バイト数 | SHA-256 |
|---|---|---|---|---|
| イラスト用の検出器 | `deepghs/anime_censor_detection` `0cf62fd6b28213b40ae0c0055f92e7ae6a96bdc2` | `censor_detect_v1.0_s/model.onnx` | 44,586,353 | `2c2524824d7d320c5619a0a73702a2e2186f619067c823d211e94f7cfe489cba` |
| 画風の分類器 | `deepghs/anime_real_cls` `097a6c1e9e62866a435810c883a45a7cb2c7077d` | `mobilenetv3_v1.4_dist/model.onnx` | 16,821,153 | `c02d68cc7f56dbcbcd4f41a10df190385c1f963f22c4eefb8d162869800ed3b0` |
| 写真用の検出器（変換元の重み） | `erax-ai/EraX-Anti-NSFW-V1.1` `90878ab981060833413ae1a24df72f5e1fff66bc` | `erax-anti-nsfw-yolo11m-v1.1.pt` | — | `5ec24336b34c2bc8ba7fab6731a260dce55de26e5db87da2b80fd1fea09b1ec8` |

**macOS / Linux:**

```sh
mkdir -p models
curl -L -o models/anime_det.onnx \
  https://huggingface.co/deepghs/anime_censor_detection/resolve/0cf62fd6b28213b40ae0c0055f92e7ae6a96bdc2/censor_detect_v1.0_s/model.onnx
curl -L -o models/style.onnx \
  https://huggingface.co/deepghs/anime_real_cls/resolve/097a6c1e9e62866a435810c883a45a7cb2c7077d/mobilenetv3_v1.4_dist/model.onnx
curl -L -o models/erax-anti-nsfw-yolo11m-v1.1.pt \
  https://huggingface.co/erax-ai/EraX-Anti-NSFW-V1.1/resolve/90878ab981060833413ae1a24df72f5e1fff66bc/erax-anti-nsfw-yolo11m-v1.1.pt
shasum -a 256 models/*
```

**Windows (PowerShell):**

- `curl` は `Invoke-WebRequest` の別名のため `curl.exe` を、`mkdir -p models` の代わりに `New-Item -ItemType Directory -Force models` を使用してください。
- SHA-256 の照合には `certutil -hashfile <ファイル> SHA256` を使用してください。

- イラスト用の検出器の入力は動的な形で、付属情報に `imgsz` がないため、`stretch` で 640×640 に引き伸ばして使います。クラスは `nipple_f`・`penis`・`pussy`、対象は `penis`・`pussy` です。
- 画風の分類器の入力は `input` `[1,3,384,384]`、出力は `[1,2]` で、ラベルは `anime`・`real`（リポジトリの `meta.json` の順）です。

### 8.2 写真用の検出器の変換（EraX の重みから ONNX へ）

EraX の配布は `.pt` だけなので、ONNX に一度だけ自分で変換します。変換用の Python 環境は、ハーネスの実行環境とは別に作ります（例: 仮想環境）。

```python
# 変換時の版: ultralytics 8.4.215（torch 2.8.0、onnx 1.19.1）
from ultralytics import YOLO
YOLO('erax-anti-nsfw-yolo11m-v1.1.pt').export(format='onnx', imgsz=640, dynamic=False, simplify=False)
```

- 書き出された ONNX は、入力 `images` [1,3,640,640]、出力 `output0` [1,9,8400] です。クラスは `anus`・`make_love`・`nipple`・`penis`・`vagina` で、対象は `penis`・`vagina`・`anus`、前処理は `letterbox` です。
- 変換後の ONNX のハッシュは、変換した環境の版によって変わります。**組み込み先の組織が、自分で変換したファイルの SHA-256 を `DETECT_PHOTO_SHA256` に記録してください**（参考: 上記の環境の変換では `3a6909939428c7ce2d33b8cc22be66561a6f95c1f09febdd351c85f81993bb19` でした。**この値はコピーせず、自分の変換の値を記録してください**）。`.pt` 側の SHA-256（上の表）で、変換元が同じであることを確かめられます。
- 書き出された ONNX の付属情報には、ライセンスが `AGPL-3.0 License (https://ultralytics.com/license)`、作者が Ultralytics と入っています。次の「ライセンスの注意」を参照してください。

### 8.3 設定の例

```sh
# .env（キーは環境変数でも渡せる。値は例）
DETECT=1
DETECT_ANIME_MODEL=models/anime_det.onnx
DETECT_ANIME_SHA256=2c2524824d7d320c5619a0a73702a2e2186f619067c823d211e94f7cfe489cba
DETECT_PHOTO_MODEL=models/erax-anti-nsfw-yolo11m-v1.1.onnx
DETECT_PHOTO_SHA256=<自分で変換したファイルの SHA-256>
STYLE_MODEL=models/style.onnx
STYLE_SHA256=c02d68cc7f56dbcbcd4f41a10df190385c1f963f22c4eefb8d162869800ed3b0
```

- **検出器を 1 つだけ使う場合**: `STYLE_MODEL` は設定せず、その検出器を常に使います。
- **起動時の自己検査**: 起動時に、ファイル・SHA-256・クラス名・試しの推論を検査し、失敗したら変数名を示して止まります（パスと値は出しません）。評価 CLI（`eval/run_eval.ts`）も同じ設定で動きます。

> [!WARNING]
> `onnxruntime-node` の install スクリプトは、linux/x64 では CUDA 向けのパッケージを取得します（linux/x64 で取得されるものはハッシュで照合されません）。
> - **`DETECT` を使わない配置では、`ONNXRUNTIME_NODE_INSTALL=skip` を推奨します。** 取得を止めるには、環境変数 `ONNXRUNTIME_NODE_INSTALL=skip`（または npm の設定 `onnxruntime-node-install=skip`）を付けて `npm ci` を実行してください。
> - **`npm ci --omit=optional` は使わないでください。** `sharp` のプラットフォーム別バイナリも入らなくなります。

### 8.4 判定回数と時間の目安

各描画の判定は、全体の 1 回に加えて切り出しが最大 `DETECT_MAX_CROPS` 回です。

- **最悪の判定回数**: `描画数 ×（1 + DETECT_MAX_CROPS）` 回（既定の `DETECT_MAX_CROPS=4` では、PSD の 32 描画で 160 回、GIF の 100 フレームで 500 回）。
- **追加の負荷**: これに描画ごとの ONNX 推論（`DETECT_THREADS`）が加わります。
- **推奨対応**: **クライアントのタイムアウトと `QUEUE_TIMEOUT_S` を見直してください**。時間は実測で確かめ、重いときは `DETECT_MAX_CROPS` を下げます。

M5 の実測（Mac mini M6、32 GB。判定器は Qwen3.8-27B）です。

- 検出: 1 描画あたり 65〜165 ms。
- RSS: 98 MB → 読み込み後 693 MB → 最大 897 MB。
- イベントループ: `onnxruntime-node` の推論は JS のスレッドで同期に動くため、1 回で最大約 100 ms 止まります（`/healthz` の応答の最大は 76 ms）。同時の要求が増えると積み重なります。`worker_threads` への移設は先送りしています。
- 25 枚の通し: 1 枚あたりの平均が 6.9 秒から 9.7 秒になりました。

#### 前処理の既知の差

- `letterbox`（写真用）のスコアは、参照（Ultralytics、cv2 の `INTER_LINEAR`）と最大 0.05 程度ずれることがあります（M5 の実測は 0.0498）。
- `stretch` で 640 へ拡大する画像は、参照との一致を確かめていません。
- しきい値（`DETECT_*_THRESHOLD`）を詰めるときは、この差の分の余裕を持たせてください。

### 8.5 回復と較正の写し

- 問題があれば `DETECT=0`（または空）に戻すと、今までの判定になります。
- `DETECT=1` で `--write` して作った `calibration.json` は、`DETECT=1` 用です。`DETECT=0` に戻すときは、以前のファイルに戻すか、削除して恒等の較正に戻してください。**`--write` の前に、今の `calibration.json` の写しを残してください**。
- `DETECT=1` では、較正の `a` が 0 より大きいことを求めます（切り出しの NG を見逃さないため）。`a ≤ 0` になる `--write` は、書かずに止まります。

### 8.6 ライセンスの注意

組み込み先の組織は、使うモデルのライセンスを、**法務で確認してから**採用してください。

- **イラスト用の検出器**: Hugging Face の記載は MIT です。ただし YOLOv8 の構成であり、Ultralytics で学習したモデルとみられるため、Ultralytics が主張する AGPL-3.0（学習したモデルにも及ぶという解釈）が及びうる可能性があります。
- **画風の分類器**: OpenRAIL です。用途の制限が付くので、利用目的が許されるか確かめてください。
- **写真用の検出器**: 重みの配布は Apache-2.0 ですが、Ultralytics で変換した ONNX の付属情報には AGPL-3.0 と記載されます。同じ Ultralytics の主張が及びうるので、イラスト用と同様に確認してください。
- **onnxruntime-node**: 本体は MIT です。npm のパッケージには ThirdPartyNotices が含まれません。組み込み先に渡すライセンス一覧には、`microsoft/onnxruntime` の GitHub リポジトリのタグ `v1.31.1` にある `ThirdPartyNotices.txt` を含めてください。

## 9. 完了と記録

- **完了**: 「0. 合格目標」の基準を、3 回以内の評価で満たしたとき。
- **未達**: 結果の数値（件数・ECE だけ。画像は含めない）を添えて、プロンプトや推論方式の見直しを検討します。
- **記録**: 数値結果は `docs/eval-log.md` などに残します（画像・機密は書かない）。

## 公開前の注意

次は Git に入れません。公開前に、ステージ済みの全ファイルを読み、秘密情報と DocBase 由来の内容が無いことを確かめます。

- 評価データ・結果: `eval/images/`、`eval/labels.csv`、`eval/results.jsonl`
- ローカル設定: `calibration.json`、`docbase.json`、`.env`（API キーを含みうる。共有フォルダと配布物に入れない。macOS では `chmod 600 .env`、Windows では利用者だけが読めるフォルダに置く）
- モデルファイル: `models/`、`*.onnx`（配布物にも含めない。変換元の `.pt` も `models/` に置く。`.gitignore` の対象は `models/` と `*.onnx` で、`models/` の外の `.pt` は対象外なので、ステージしない）
- DocBase 由来: `rules/docbase/`、`rules.local.md`
- 認証情報: API キー、DocBase トークン
