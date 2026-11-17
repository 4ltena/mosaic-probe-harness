import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { Config } from './config.ts'
import { detailJson } from './http.ts'
import { CheckError, DETAIL_FIELDS, type Detail } from './types.ts'

const DATA_PREFIX = /^data:[^;,]*;base64,/
// ponytail: 空白の除去と文字種の検査だけ。MIME 種別は見ない（画像の正当性は normalize が判定する）
const B64 = /^[A-Za-z0-9+/]+={0,2}$/

/** base64 を復号する。data: 接頭辞と改行・空白を許容し、不正・上限超過は bad_input。 */
function decode(input: string, maxMb: number): Uint8Array {
  const maxBytes = Math.floor(maxMb * 1024 * 1024)
  // 復号前に長さで弾く（巨大入力の割り当てを避ける）
  if (input.length > Math.ceil((maxBytes * 4) / 3) + 1024) {
    throw new CheckError('bad_input', '画像が上限を超えています')
  }
  const s = input.trim().replace(DATA_PREFIX, '').replace(/\s+/g, '')
  if (s === '' || !B64.test(s)) throw new CheckError('bad_input', 'base64 が空、または不正です')
  const bytes = Buffer.from(s, 'base64')
  // 復号後のサイズも確かめる（REST の生バイトと同じ上限）
  if (bytes.length > maxBytes) throw new CheckError('bad_input', '画像が上限を超えています')
  return bytes
}

/**
 * MCP（Streamable HTTP、ステートレス・JSON 応答）のハンドラを作る。
 * リクエストごとに McpServer と transport を作り、応答が閉じたら破棄する。
 * parsedBody は http.ts が上限つきで読んで JSON 解析した本文（SDK の既定の 4 MiB 上限を使わないため）。
 * checkDetail があり detail: true のときだけ、成功の本文は詳細 JSON の文字列になる。
 */
export function createMcpHandler(
  check: (bytes: Uint8Array, signal: AbortSignal) => Promise<number>,
  cfg: Config,
  checkDetail?: (bytes: Uint8Array, signal: AbortSignal) => Promise<Detail>,
): (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void> {
  return async (req, res, parsedBody) => {
    // 切断されたら判定も止める（判定の signal）
    const ac = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) ac.abort()
    })
    const server = new McpServer({ name: 'mosaic-probe-harness', version: '0.1.0' })
    server.registerTool(
      'check_mosaic',
      {
        description: '画像がモザイク処理済み（または処理不要）である確率を 0〜1 で返す',
        inputSchema: {
          image_base64: z.string(),
          detail: z.boolean().optional().describe('true なら p_ok・judgment・confidence・render・classes の詳細 JSON を返す'),
          fields: z
            .array(z.enum(DETAIL_FIELDS))
            .min(1)
            .optional()
            .describe('詳細 JSON に含める項目を絞る（p_ok は常に含む）。例: ["judgment"]、["confidence"]、["judgment","confidence"]。指定すると detail は不要'),
        },
      },
      async ({ image_base64, detail, fields }) => {
        try {
          const bytes = decode(image_base64, cfg.maxImageMb)
          if ((detail === true || fields !== undefined) && checkDetail) {
            const d = detailJson(await checkDetail(bytes, ac.signal), fields)
            if (!d) throw new CheckError('internal', '判定値が範囲外です')
            return { content: [{ type: 'text', text: JSON.stringify(d) }] }
          }
          const n = await check(bytes, ac.signal)
          if (!Number.isFinite(n) || n < 0 || n > 1) throw new CheckError('internal', '判定値が範囲外です')
          return { content: [{ type: 'text', text: String(n) }] }
        } catch (e) {
          // 想定外の例外は内容を出さず internal に包む
          const err = e instanceof CheckError ? e : new CheckError('internal', '内部エラー')
          return { isError: true, content: [{ type: 'text', text: `error: ${err.kind}: ${err.message}` }] }
        }
      },
    )
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    try {
      await transport.handleRequest(req, res, parsedBody)
    } catch {
      if (!res.headersSent) res.statusCode = 500
      res.end()
    }
  }
}
