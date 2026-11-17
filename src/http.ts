import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Config } from './config.ts'
import { authOk, corsHeaders, ipAllowed } from './net.ts'
import { CheckError, HTTP_STATUS_OF_KIND } from './types.ts'

export interface Handlers {
  check(bytes: Uint8Array, signal: AbortSignal): Promise<number>
  /** parsedBody は POST の上限つき読み取り・JSON 解析の結果（GET など本文を読まない要求では無い）。 */
  mcp?: (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void>
}

// JSON の包み（キー名など）の余裕。base64 の上限計算に足す。
const JSON_SLACK = 1024
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** 生バイト または JSON `{"image_base64": "..."}` を受ける HTTP サーバー。listen は呼び出し側。 */
export function createHttpServer(
  cfg: Config,
  h: Handlers,
  log: (line: string) => void = (l) => console.log(l),
): Server {
  const maxBytes = Math.floor(cfg.maxImageMb * 1024 * 1024)

  return createServer((req, res) => {
    const started = performance.now()
    // 解釈できない request-target は例外にせず、空パス（どの経路にも一致せず 404）として扱う
    let path = ''
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      // path は空のまま
    }
    // ログ用。本文・キーは入れない
    const meta = { sha: '-', size: 0 }
    const privateNetwork = req.headers['access-control-request-private-network'] === 'true'
    for (const [k, v] of Object.entries(corsHeaders(req.headers.origin, cfg, privateNetwork))) res.setHeader(k, v)
    res.on('close', () => {
      const status = res.writableFinished ? res.statusCode : 'aborted'
      log(`${req.method} ${path} ${status} ${Math.round(performance.now() - started)}ms sha12=${meta.sha} size=${meta.size}`)
    })
    route(req, res, path, meta).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
      else res.end()
    })
  })

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    meta: { sha: string; size: number },
  ): Promise<void> {
    if (!ipAllowed(req.socket.remoteAddress, cfg.allowCidrs)) return sendJson(res, 403, { error: 'forbidden' })
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (path === '/healthz') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' })
      return sendText(res, 200, 'ok')
    }
    if (!authOk(req.headers.authorization, cfg.apiKey)) {
      return sendJson(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' })
    }
    if (path === '/mcp') {
      if (!h.mcp) return sendJson(res, 404, { error: 'not_found' })
      if (req.method !== 'POST') return h.mcp(req, res)
      // SDK の既定上限（4 MiB）ではなく、MAX_IMAGE_MB に合わせた上限で溜める前に打ち切る
      const body = await readBody(req, Math.ceil((maxBytes * 4) / 3) + JSON_SLACK)
      if (!body) return sendJson(res, 413, { error: 'too_large' }, { Connection: 'close' })
      let parsed: unknown
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null })
      }
      return h.mcp(req, res, parsed)
    }
    if (path === '/v1/check') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' })
      return handleCheck(req, res, meta)
    }
    return sendJson(res, 404, { error: 'not_found' })
  }

  async function handleCheck(
    req: IncomingMessage,
    res: ServerResponse,
    meta: { sha: string; size: number },
  ): Promise<void> {
    const isJson = String(req.headers['content-type'] ?? '').startsWith('application/json')
    const limit = isJson ? Math.ceil((maxBytes * 4) / 3) + JSON_SLACK : maxBytes
    const body = await readBody(req, limit)
    if (!body) return sendJson(res, 413, { error: 'too_large' }, { Connection: 'close' })

    let bytes: Uint8Array
    if (isJson) {
      let obj: unknown
      try {
        obj = JSON.parse(body.toString('utf8'))
      } catch {
        return sendJson(res, 400, { error: 'bad_input', message: 'JSON を解釈できません' })
      }
      const b64 = obj !== null && typeof obj === 'object' ? (obj as Record<string, unknown>).image_base64 : undefined
      const decoded = typeof b64 === 'string' ? decodeB64(b64) : undefined
      if (!decoded) return sendJson(res, 400, { error: 'bad_input', message: 'image_base64 が不正です' })
      bytes = decoded
    } else {
      bytes = body
    }
    if (bytes.length === 0) return sendJson(res, 400, { error: 'bad_input', message: '画像が空です' })
    if (bytes.length > maxBytes) return sendJson(res, 413, { error: 'too_large' }, { Connection: 'close' })

    meta.size = bytes.length
    meta.sha = createHash('sha256').update(bytes).digest('hex').slice(0, 12)

    const ac = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) ac.abort()
    })
    try {
      const n = await h.check(bytes, ac.signal)
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) {
        return sendJson(res, 500, { error: 'internal' })
      }
      return sendText(res, 200, JSON.stringify(n), 'application/json; charset=utf-8')
    } catch (e) {
      if (e instanceof CheckError) {
        const extra: Record<string, string> = e.kind === 'busy' ? { 'Retry-After': '5' } : {}
        return sendJson(res, HTTP_STATUS_OF_KIND[e.kind], { error: e.kind, message: e.message }, extra)
      }
      return sendJson(res, 500, { error: 'internal' })
    }
  }
}

/** 上限を超えたら本文を溜めずに破棄し null を返す。 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > limit) {
        chunks.length = 0
        req.removeAllListeners('data')
        req.resume()
        resolve(null)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** data: 接頭辞と空白を除いて base64 を復号する。不正なら undefined。 */
function decodeB64(s: string): Buffer | undefined {
  const t = s.replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
  if (!B64_RE.test(t) || t.length % 4 === 1) return undefined
  return Buffer.from(t, 'base64')
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra })
  res.end(JSON.stringify(body))
}

function sendText(res: ServerResponse, status: number, text: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type })
  res.end(text)
}
