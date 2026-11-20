# Mac mini の状態を LAN から確認する

Mac mini 本体の状態は、Mac mini 上で稼働している **macmini-hub の Health 画面または API** で確認できます。Mosaic の `GET /healthz` は画像判定サーバーの生存確認に使います。

## 既存のダッシュボードを使う

運用者から案内された macmini-hub のダッシュボード URL を LAN 内から開き、既存の認証でログインして **Health** を選びます。CPU、メモリー、GPU などの計測値と履歴は、macmini-hub が取得したものです。未取得の項目は欠測として扱います。

## 既存の API を使う

macmini-hub の認証付き `GET /api/health` にアクセスします。取得期間は `range=24h` または `range=7d` です。SSH 転送では、照会する機器のループバックから Mac mini 側のハブへ接続します。以下はハブが `127.0.0.1:8790` を許可し、手元の転送ポートを `18719` にした例です。`--connect-to` で接続先だけを転送ポートに切り替え、HTTP の `Host` はハブの許可値に合わせます。

```sh
curl --fail-with-body --silent --show-error --noproxy 127.0.0.1 \
  --connect-to '127.0.0.1:8790:127.0.0.1:18719' \
  --header "@$MAC_HUB_AUTH_HEADER_FILE" \
  'http://127.0.0.1:8790/api/health?range=24h'
```

`MAC_HUB_AUTH_HEADER_FILE` は運用者が管理するヘッダーファイルのパスです。ファイルには既存の macmini-hub 用の `Authorization: Bearer …` を設定し、アクセス権を運用者または監視プロセスに絞ります。運用中の HTTPS 経路がある場合は、照会先にその URL を使えます。

## Merak の Health 画面に登録する

既存の Merak を使う場合は、次の項目を Health 設定の `hosts` に追加します。同じ Mac mini がすでに登録されている場合はその項目を使います。

```json
{
  "id": "mac-mini",
  "label": "Mac mini",
  "role": "画像判定ホスト",
  "source": {
    "kind": "mac_hub",
    "url": "http://127.0.0.1:8790/api/health?range=24h",
    "token_file": "mac-hub.token"
  }
}
```

この URL は **Merak を実行する機器から見た接続先**です。例では手元の `127.0.0.1:8790` から Mac mini 側の `127.0.0.1:8790` に転送します。URL のホスト名とポートは、ハブの `allowed_hosts` が許可する値と一致させます。手元で同じポートが使えない場合は、既存の HTTPS 経路など、ハブが許可済みの接続先を使います。適切な経路がなければ、配備前に管理者が接続方式を決めます。

`token_file` には macmini-hub のトークンだけを保存し、Merak の Health 設定ファイルからの相対パスで指定します。Mac mini 本体と Mosaic の応答を同じ画面で見る場合は、Mosaic の `/healthz` を Merak の既存の `http` 監視に別項目として登録できます。

macmini-hub と Mosaic を同じ機器で稼働させる場合は、待受アドレスとポートが重複しないよう実効設定を確認してください。
