@echo off
REM mosaic-probe-harness を起動する（Windows）。
REM 使い方: start.bat   （llama-server は先に起動しておく。README 参照）
REM
REM 環境変数の例（必要なものだけ設定する。実際のキーや IP はこのファイルに書かない）:
REM set VLM_BASE_URL=http://127.0.0.1:8080
REM set VLM_BASE_URLS=http://<台1のIP>:8080,http://<台2のIP>:8080
REM set VLM_SLOTS_PER_BACKEND=1
REM set VLM_MODEL=<モデル名>
REM set MOSAIC_BIND=127.0.0.1
REM set MOSAIC_PORT=8790
REM set MOSAIC_API_KEY=<長いランダム文字列>
REM set MOSAIC_ALLOW_CIDRS=127.0.0.0/8,10.0.0.0/8,192.168.0.0/16
REM set MOSAIC_CORS_ORIGINS=<許可する Origin のカンマ区切り。省略時はキーありで *>
REM set QUEUE_TIMEOUT_S=60

cd /d "%~dp0"
call npx tsx src\server.ts
