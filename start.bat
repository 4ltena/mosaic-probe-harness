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
REM
REM 環境変数のかわりに、アプリのルートの .env にも書ける（例は .env.example。環境変数が同じ名前なら環境変数が優先）。
REM .env は Git に入れない。利用者だけが読めるフォルダに置き、共有フォルダと配布物に含めない。キーは環境変数でも渡せる。
REM 既存の .env は DETECT と関係なく読まれる。前段の検出（DETECT=1）の設定は README を参照。

cd /d "%~dp0"
call npx tsx src\server.ts
