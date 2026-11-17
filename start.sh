#!/bin/sh
# mosaic-probe-harness を起動する（macOS / Linux）。
# 使い方: ./start.sh   （llama-server は先に起動しておく。README 参照）
#
# 環境変数の例（必要なものだけ設定する。実際のキーや IP はこのファイルに書かない）:
# export VLM_BASE_URL=http://127.0.0.1:8080       # llama-server（ループバックのみ）
# export VLM_BASE_URLS=http://<台1のIP>:8080,http://<台2のIP>:8080  # 複数台（任意）
# export VLM_SLOTS_PER_BACKEND=1                  # 1 台あたりの同時実行数（llama-server --parallel に合わせる）
# export VLM_MODEL=<モデル名>
# export MOSAIC_BIND=127.0.0.1                    # LAN に出すときは 0.0.0.0（その場合 MOSAIC_API_KEY が必須）
# export MOSAIC_PORT=8790
# export MOSAIC_API_KEY=<長いランダム文字列>
# export MOSAIC_ALLOW_CIDRS=127.0.0.0/8,10.0.0.0/8,192.168.0.0/16
# export MOSAIC_CORS_ORIGINS=<許可する Origin のカンマ区切り。省略時はキーありで *>
# export QUEUE_TIMEOUT_S=60

set -eu
cd "$(dirname "$0")"
exec npx tsx src/server.ts
