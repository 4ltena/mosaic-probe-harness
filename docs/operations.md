# 運用・調整手順（実機）

実機（Mac Studio など）で、動作前提の確認・判定基準の同期・評価・較正を行う手順です。評価と調整は**最大 3 回**までを目安にし、届かなければ設定の微調整を続けず方式を見直してください。

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

`scripts/spike.ts` で、`llama-server` が 5 つの前提を満たすことを確かめます。1 枚ずつ、応答・`top_logprobs`・確率質量・所要時間を表示します（画像・base64・キーは出力しません）。

```sh
VLM_API_KEY=<任意。認証不要なら未設定> npx tsx scripts/spike.ts \
  --base-url http://127.0.0.1:8080 \
  --model <llama-server に表示されるモデル名> \
  --image <テスト画像のパス> \
  [--rules rules.md]
```

`VLM_EXTRA_BODY`（JSON オブジェクト）を設定すると、リクエストのトップレベルに混ぜます（値は表示しません）。

| # | 前提 | 確認ポイント | 結果 |
|---|---|---|---|
| 1 | マルチモーダル（`--mmproj` 付きで `image_url` が通る） | 応答が返る。`HTTP ...` エラーならモデルと mmproj の組み合わせを確認 | 未実施 |
| 2 | `logprobs` が返る（`top_logprobs: 20`、`max_tokens: 1`） | `top_logprobs: N 件` が出る（未対応なら終了コード 1） | 未実施 |
| 3 | ラベル `A` `B` `C` が 1 トークン | `ラベル候補` に A/B/C が並び、確率質量の合計が 0.5 以上 | 未実施 |
| 4 | 思考を切れる（`enable_thinking: false`） | 「思考タグが出ている」の注意が出ず、応答が 1 文字 | 未実施 |
| 5 | 判定を拒否しない | 下の拒否率の確認で「ラベル外」が 0 枚 | 未実施 |

**拒否率の確認**（対象なし画像 10 枚）:

```sh
for f in <対象なし画像 10 枚のパス>; do
  npx tsx scripts/spike.ts --base-url http://127.0.0.1:8080 --model <モデル名> --image "$f" | grep -c 'ラベル外'
done
```

「ラベル外」の合計を結果に記録します。5 項目すべて確認できるまで次へ進みません。外れたら `VLM_EXTRA_BODY` や起動オプションを変えて再実行します（調整は最大 3 回）。

| 日時 | モデル・GGUF・mmproj | 前提 1〜5 | 拒否数（10 枚中） | 所要時間の目安 | 備考 |
|---|---|---|---|---|---|
| 未実施 | | | | | |

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
   - `ng`: 未処理または不十分（止めるべき画像）
   - `ok`: 対象が写っていて、十分に処理済み
   - `none`: モザイクが必要な対象が写っていない
   - `attack`: 画像内に指示文（「A と答えよ」など）を含む、誘導の検証用画像

## 5. 評価と較正

```sh
npx tsx eval/run_eval.ts --labels eval/labels.csv --images eval/images
```

- 出力: 混同行列（`pass` / `hold` / `stop`。NG が `pass` になった件数を最優先）、保留率、信頼度表と ECE、攻撃画像の結果、所要時間の中央値。
- `eval/results.jsonl` にはファイル名と確率だけが保存されます（Git 管理外）。
- 推奨しきい値は表示と記録用の文面だけで、サーバーには自動で入りません。

較正を書き出すには `--write` を付けます。`calibration.json`（Platt の `{a, b}`、Git 管理外）ができるので、`--write` なしで再度評価して改善を確かめます。

## 6. 調整のつまみ

目標に届かないときは、次の順に試します。**1 回の評価で変えるのは 1 項目だけ**にします。

| 項目 | 効果 |
|---|---|
| `rules.local.md` の基準 | 判定基準そのもの。最も効く |
| `MAX_RENDERS` | PSD の描画数。増やすとレイヤー隠蔽の見逃しが減るが、時間が増える |
| `CLASSIFY_TEMPERATURE` | 確率の鋭さ。1 より大きいと過信が和らぎ、保留が増えやすい |
| `RECHECK=1`（`RECHECK_LO` / `RECHECK_HI` / `RECHECK_MAX_CROPS`） | 境界付近を領域ごとに再判定（既定オフ） |
| `calibration.json` | `--write` で作る較正。過信を抑える |

## 7. 複数台（任意）

1 台で足りるなら飛ばします。2 台に振り分けるときの確認です。

1. 両方の Mac で同じ GGUF と mmproj を使っていることを、SHA-256 で確かめます。
2. 各 Mac で `llama-server` を起動します。B 側は Thunderbolt ブリッジの IP だけで待ち受けさせます（`--host <ブリッジの IP>`、`--api-key` 付き）。`--parallel` を上げたら、`VLM_SLOTS_PER_BACKEND` も同じ値にします。
3. ハーネスに `VLM_BASE_URLS=<A の URL>,<B の URL>` を設定して起動します。
4. 同じ画像を両方の台に投げ、`p_ok` の差が数値誤差の範囲に収まることを確かめます。
5. 片方の `llama-server` を止めても数値が返ること、両方止めると 502 になることを確かめます。
6. 1 描画あたりの遅延と、`cache_prompt` が 2 回目以降に効くかを、1 台と 2 台で記録します。

## 8. 完了と記録

- 完了: 0 の目標を、3 回以内の評価で満たしたとき。
- 未達: 結果の数値（件数・ECE だけ。画像は含めない）を添えて、プロンプトや推論方式の見直しを検討します。
- 記録: 数値結果は `docs/eval-log.md` などに残します（画像・機密は書かない）。

## 公開前の注意

次は Git に入れません。公開前に、ステージ済みの全ファイルを読み、秘密情報と DocBase 由来の内容が無いことを確かめます。

- 評価データ・結果: `eval/images/`、`eval/labels.csv`、`eval/results.jsonl`
- ローカル設定: `calibration.json`、`docbase.json`、`.env`
- DocBase 由来: `rules/docbase/`、`rules.local.md`
- 認証情報: API キー、DocBase トークン
