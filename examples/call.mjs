// REST と MCP の呼び出し例。キーは環境変数 MOSAIC_API_KEY から読む（コードに書かない）。
// 使い方: MOSAIC_URL=http://127.0.0.1:8790 node examples/call.mjs <画像ファイル>
import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const base = (process.env.MOSAIC_URL ?? 'http://127.0.0.1:8790').replace(/\/+$/, '')
const key = process.env.MOSAIC_API_KEY
const file = process.argv[2]
if (!file) throw new Error('画像ファイルを引数に指定してください')

const bytes = await readFile(file)
const auth = key ? { Authorization: `Bearer ${key}` } : {}

// REST: 生バイトを送る。成功は数値 1 個だけの本文。
const res = await fetch(`${base}/v1/check`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/octet-stream' },
  body: bytes,
})
const text = await res.text()
if (res.ok) console.log('REST p_ok =', Number(text))
else console.log('REST 失敗', res.status, text)

// MCP: check_mosaic ツールを呼ぶ。成功は数値のテキストだけ。
const client = new Client({ name: 'example-client', version: '0.1.0' })
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: auth },
})
await client.connect(transport)
try {
  const r = await client.callTool({
    name: 'check_mosaic',
    arguments: { image_base64: bytes.toString('base64') },
  })
  const t = r.content[0]?.text ?? ''
  if (r.isError) console.log('MCP 失敗', t)
  else console.log('MCP p_ok =', Number(t))
} finally {
  await client.close()
}
