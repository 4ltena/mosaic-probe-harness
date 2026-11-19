// 本番と同じ問い合わせで、1 枚の静止画に対する判定器の前提を確認する。
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { loadConfig } from '../src/config.ts'
import { normalize } from '../src/images.ts'
import { CheckError } from '../src/types.ts'
import { buildJudges } from '../src/vlm.ts'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string' },
      model: { type: 'string' },
      image: { type: 'string' },
      rules: { type: 'string' },
    },
  })
  if (!values['base-url'] || !values.model || !values.image) {
    console.error('使い方: --base-url <url> --model <名前> --image <path> [--rules <path>]')
    process.exitCode = 2
    return
  }

  const cfg = loadConfig({
    ...process.env,
    JUDGES: undefined,
    VLM_BASE_URLS: undefined,
    VLM_BASE_URL: values['base-url'],
    VLM_MODEL: values.model,
  })
  if (values.rules) cfg.rulesPath = values.rules
  const [judge] = buildJudges(cfg)
  const png = await normalize(readFileSync(values.image), cfg)
  const started = performance.now()
  const probs = await judge!.judge(png)
  console.log(JSON.stringify({ probs, elapsed_ms: Math.round(performance.now() - started) }))
}

main().catch((e: unknown) => {
  console.error(e instanceof CheckError ? `失敗: ${e.kind}: ${e.message}` : '失敗: 入力または設定を確認してください')
  process.exitCode = 1
})