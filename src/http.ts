import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Config } from './config.ts'
import { authOk, corsHeaders, ipAllowed } from './net.ts'
import {
  type Box, CheckError, DETAIL_FIELDS, type Detail, type DetailField, HTTP_STATUS_OF_KIND, type Judgment, PsdRenderLimitError, type Style,
} from './types.ts'

export interface Handlers {
  check(bytes: Uint8Array, signal: AbortSignal): Promise<number>
  /** `?detail=1` の応答。無ければ detail 要求は 501。 */
  checkDetail?(bytes: Uint8Array, signal: AbortSignal): Promise<Detail>
  /** parsedBody は POST の上限つき読み取り・JSON 解析の結果（GET など本文を読まない要求では無い）。 */
  mcp?: (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void>
}

/** 詳細応答の本文（REST と MCP で共通）。 */
export interface DetailJson {
  p_ok: number
  judgment?: Judgment
  confidence?: number
  render?: string
  classes?: Detail['classes']
  /** モデル別の ok / ng（内部の 4 語を classes と同じ式でまとめたもの）。 */
  per_model?: Record<string, Detail['classes']>
  /** DETECT=1 の detail だけ。style と p_real は分類器がなければ null。箱の座標は width × height の描画の画素。 */
  detect?: {
    style: Style['use'] | null
    p_real: number | null
    width: number
    height: number
    boxes: Box[]
  }
}

const JUDGMENTS: readonly string[] = ['ok', 'ng']

/**
 * fields の文字列（カンマ区切り）を解釈する。空・未知の項目・空要素があれば undefined（呼び出し側が 400 にする）。
 * 重複は除き、順序は DETAIL_FIELDS の順に揃える。
 */
export function parseFields(raw: string): DetailField[] | undefined {
  const parts = raw.split(',').map((s) => s.trim())
  if (parts.length === 0 || parts.some((p) => !(DETAIL_FIELDS as readonly string[]).includes(p))) return undefined
  return DETAIL_FIELDS.filter((f) => parts.includes(f))
}

/**
 * 詳細を本文の形にする。p_ok は常に含み、fields で選んだ項目だけを足す（未指定なら全部）。
 * 値が非有限・範囲外なら、選ばなかった項目も含めて undefined（数値も JSON も返さない）。
 */
export function detailJson(d: Detail, fields?: readonly DetailField[]): DetailJson | undefined {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
  const c = d.classes
  if (!ok(d.pOk) || typeof d.render !== 'string' || !c) return undefined
  if (!ok(c.ok) || !ok(c.ng)) return undefined
  if (!JUDGMENTS.includes(d.judgment) || !ok(d.confidence)) return undefined
  const out: DetailJson = { p_ok: d.pOk }
  const selected = fields ?? DETAIL_FIELDS
  if (selected.includes('judgment')) out.judgment = d.judgment
  if (selected.includes('confidence')) out.confidence = d.confidence
  if (selected.includes('render')) out.render = d.render
  if (selected.includes('classes')) out.classes = { ok: c.ok, ng: c.ng }
  if (!fields) {
    if (!d.perModel) return undefined
    const entries = Object.entries(d.perModel)
    for (const [, p] of entries) {
      if (!p || !ok(p.none) || !ok(p.processed) || !ok(p.forgot) || !ok(p.nori)) return undefined
    }
    out.per_model = Object.fromEntries(entries.map(([name, p]) =>
      [name, { ok: Math.min(1, p.none + p.processed), ng: Math.max(p.forgot, p.nori) }]))
    const f = d.detect
    if (f) {
      const px = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max
      if (!px(f.width, Infinity) || !px(f.height, Infinity) || (f.style && !ok(f.style.pReal))) return undefined
      if (f.boxes.some((b) => !ok(b.score) || !px(b.x0, f.width) || !px(b.x1, f.width) || !px(b.y0, f.height) || !px(b.y1, f.height))) return undefined
      out.detect = {
        style: f.style?.use ?? null,
        p_real: f.style?.pReal ?? null,
        width: f.width,
        height: f.height,
        boxes: f.boxes.map(({ label, score, x0, y0, x1, y1 }) => ({ label, score, x0, y0, x1, y1 })),
      }
    }
  }
  return out
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
    const params = new URL(req.url ?? '/', 'http://localhost').searchParams
    const q = params.get('detail')
    // fields があれば、その項目だけを返す（detail=1 を併記しても fields が優先）。不正な指定は黙って捨てず 400
    const fieldsRaw = params.get('fields')
    const fields = fieldsRaw === null ? undefined : parseFields(fieldsRaw)
    if (fieldsRaw !== null && !fields) {
      return sendJson(res, 400, {
        error: 'bad_input',
        message: 'fields は judgment, confidence, render, classes のカンマ区切りで指定してください',
      })
    }
    const wantDetail = q === '1' || q === 'true' || fields !== undefined
    const cd = wantDetail ? h.checkDetail : undefined
    if (wantDetail && !cd) return sendJson(res, 501, { error: 'not_implemented' })
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
      if (cd) {
        const d = detailJson(await cd(bytes, ac.signal), fields)
        if (!d) return sendJson(res, 500, { error: 'internal' })
        return sendJson(res, 200, d)
      }
      const n = await h.check(bytes, ac.signal)
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) {
        return sendJson(res, 500, { error: 'internal' })
      }
      return sendText(res, 200, JSON.stringify(n), 'application/json; charset=utf-8')
    } catch (e) {
      if (e instanceof CheckError) {
        const extra: Record<string, string> = e.kind === 'busy' ? { 'Retry-After': '5' } : {}
        const body = e instanceof PsdRenderLimitError ? e.body : { error: e.kind, message: e.message }
        return sendJson(res, HTTP_STATUS_OF_KIND[e.kind], body, extra)
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
