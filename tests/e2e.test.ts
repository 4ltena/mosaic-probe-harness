import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { writePsd, type Layer } from 'ag-psd'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_ALLOW_CIDRS, defaultConfig, type Config } from '../src/config.ts'
import { buildCrops } from '../src/crops.ts'
import type { Detector } from '../src/detect.ts'
import { sniff } from '../src/images.ts'
import { buildServer } from '../src/server.ts'
import type { Probs4 } from '../src/types.ts'

// 赤はかけ忘れ、黒はノリ、それ以外は処理済みの模擬確率を返す。
type Mass = Probs4
const MASS_OK: Mass = { none: 0.01, processed: 0.97, forgot: 0.015, nori: 0.005 }
const MASS_FORGOT: Mass = { none: 0.01, processed: 0.02, forgot: 0.95, nori: 0.02 }
const MASS_NORI: Mass = { none: 0.01, processed: 0.02, forgot: 0.02, nori: 0.95 }
const topLabel = (m: Mass): keyof Mass => (Object.keys(m) as (keyof Mass)[]).reduce((a, b) => (m[b] > m[a] ? b : a))
const P_OK = 0.98 / 0.995
const P_NG = 0.03 / 0.98

const KEY = 'test-key-123'
const RULES = resolve('rules.md')
// 存在しない較正ファイル（恒等の較正になる）
const NO_CAL = join(tmpdir(), `mosaic-e2e-no-calibration-${process.pid}.json`)

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

/**
 * 偽の llama-server。受けた画像の平均色で答えを決める。mode='error' で 500 を返す。
 * stream:true の要求は再判定エージェント（Pi のチャット）として扱い、SSE で返す。
 * max_tokens が小さい要求は、実際の llama-server と同じく途中で打ち切る。
 */
interface Fake {
  url: string
  mode: 'ok' | 'error'
  delayMs: number
  maxInFlight: number
  judgeCalls: number
  tokenizeCalls: number
  fixedMass?: Mass
  agentCalls: number
}

type Delta = Record<string, unknown>
const sse = (res: ServerResponse, deltas: { delta: Delta; finish: string | null }[]) => {
  res.setHeader('content-type', 'text/event-stream')
  for (const { delta, finish } of deltas) {
    const chunk = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [{ index: 0, delta, finish_reason: finish }] }
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  res.end('data: [DONE]\n\n')
}

/** エージェントの 1 ターン。ツール結果の後は「完了」、それ以外は crop を 1 回呼ぶ（max_tokens が足りなければ途中で切れる）。 */
function agentTurn(res: ServerResponse, body: { messages: { role: string }[]; max_tokens?: number; max_completion_tokens?: number }) {
  if (body.messages.at(-1)?.role === 'tool') {
    sse(res, [{ delta: { role: 'assistant', content: '完了' }, finish: null }, { delta: {}, finish: 'stop' }])
    return
  }
  const limit = body.max_tokens ?? body.max_completion_tokens ?? Infinity
  const args = limit < 64 ? '{"' : JSON.stringify({ x0: 0, y0: 0, x1: 0.25, y1: 1 })
  const call = { index: 0, id: 'call_1', type: 'function', function: { name: 'crop', arguments: args } }
  sse(res, [
    { delta: { role: 'assistant', tool_calls: [call] }, finish: null },
    { delta: {}, finish: limit < 64 ? 'length' : 'tool_calls' },
  ])
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const { port } = server.address() as AddressInfo
  closers.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  )
  return `http://127.0.0.1:${port}`
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** PNG の平均色から偽の答えを決める。赤寄り=かけ忘れ、黒寄り=ノリ、それ以外=処理済み。 */
async function massOf(dataUri: string): Promise<Mass> {
  const buf = Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64')
  const px = await sharp(buf).removeAlpha().resize(1, 1).raw().toBuffer()
  if (px[0]! > 128 && px[1]! < 128) return MASS_FORGOT
  if (px[0]! < 32 && px[1]! < 32 && px[2]! < 32) return MASS_NORI
  return MASS_OK
}

async function startFake(massForCall?: (call: number) => Mass): Promise<Fake> {
  const fake: Fake = { url: '', mode: 'ok', delayMs: 0, maxInFlight: 0, judgeCalls: 0, tokenizeCalls: 0, agentCalls: 0 }
  let inFlight = 0
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || (req.url !== '/v1/chat/completions' && req.url !== '/tokenize')) {
      res.statusCode = 404
      res.end()
      return
    }
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      content?: string
      stream?: boolean
      max_tokens?: number
      max_completion_tokens?: number
      messages: { role: string; content: { image_url?: { url: string } }[] }[]
    }
    if (req.url === '/tokenize') {
      fake.tokenizeCalls++
      const piece = body.content ?? ''
      res.end(JSON.stringify({ tokens: [{ id: Object.keys(MASS_OK).indexOf(piece), piece }] }))
      return
    }
    const prefix = 'data:image/png;base64,'
    const images = body.messages.flatMap(({ content }) =>
      Array.isArray(content) ? content.flatMap(({ image_url }) => image_url ? [image_url.url] : []) : [],
    )
    const needsImage = !body.stream || body.messages.at(-1)?.role !== 'tool'
    if ((needsImage && images.length === 0) ||
        images.some((url) => !url.startsWith(prefix) || sniff(Buffer.from(url.slice(prefix.length), 'base64')) !== 'png')) {
      res.writeHead(415).end('{}')
      return
    }
    if (body.stream) {
      fake.agentCalls++
      agentTurn(res, body)
      return
    }
    const call = ++fake.judgeCalls
    inFlight++
    fake.maxInFlight = Math.max(fake.maxInFlight, inFlight)
    try {
      await sleep(fake.delayMs)
      if (fake.mode === 'error') {
        res.statusCode = 500
        res.end('{}')
        return
      }
      const url = body.messages[1]!.content[0]!.image_url!.url
      const mass = massForCall?.(call) ?? fake.fixedMass ?? await massOf(url)
      const token = topLabel(mass)
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: token },
              logprobs: {
                content: [
                  {
                    token,
                    logprob: Math.log(mass[token]),
                    top_logprobs: Object.entries(mass).map(([t, p]) => ({ token: t, logprob: Math.log(p) })),
                  },
                ],
              },
            },
          ],
        }),
      )
    } finally {
      inFlight--
    }
  })
  fake.url = await listen(server)
  return fake
}

/** 閉じたポートの URL（接続拒否になる） */
async function closedUrl(): Promise<string> {
  const s = createServer()
  const url = await listen(s)
  await new Promise<void>((r) => s.close(() => r()))
  closers.splice(closers.length - 1, 1)
  return url
}

/** detector を渡すと、本物の buildCrops で包んで DETECT=1 の切り出しにする。 */
async function startHarness(fake: Fake | { url: string }, over: Partial<Config> = {}, detector?: Detector) {
  const lines: string[] = []
  const cfg = defaultConfig({
    bind: '127.0.0.1',
    apiKey: KEY,
    corsOrigins: '*',
    allowCidrs: DEFAULT_ALLOW_CIDRS,
    vlmBaseUrls: [fake.url],
    vlmModel: 'test-model',
    vlmTimeoutMs: 5000,
    queueTimeoutMs: 5000,
    rulesPath: RULES,
    calibrationPath: NO_CAL,
    ...over,
  })
  const crops = detector && buildCrops(cfg, detector)
  const url = await listen(buildServer(cfg, { log: (l) => lines.push(l), crops }))
  return { url, lines, cfg }
}

const pngOf = (color: string) => sharp({ create: { width: 8, height: 8, channels: 3, background: color } }).png().toBuffer()
const AUTH = { Authorization: `Bearer ${KEY}` }

/** 赤の背景に白の「モザイク」層を重ねた PSD。見えている合成は白（処理済み）。 */
const W = 4
const H = 4
const solid = (rgba: number[]) => {
  const data = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) data.set(rgba, i * 4)
  return { width: W, height: H, data }
}
const layer = (name: string, color: number[]): Layer => ({ name, left: 0, top: 0, imageData: solid(color) })
const psdWithMosaic = (): ArrayBuffer =>
  writePsd({
    width: W,
    height: H,
    children: [layer('背景', [255, 0, 0, 255]), layer('モザイク', [255, 255, 255, 255])],
    imageData: solid([255, 255, 255, 255]),
  })

async function postJson(url: string, b64: string, headers: Record<string, string> = AUTH) {
  return fetch(`${url}/v1/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ image_base64: b64 }),
  })
}

const NUMBER_ONLY = /^\d+(\.\d+)?(e-\d+)?$/

describe('e2e: REST /v1/check', () => {
  it('JSON 本文で、確率の数値 1 個だけを返す。ログに画像・キーを出さない', async () => {
    const fake = await startFake()
    const { url, lines } = await startHarness(fake)
    const b64 = (await pngOf('#ffffff')).toString('base64')

    const res = await postJson(url, `data:image/png;base64,${b64}`)
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(text).toMatch(NUMBER_ONLY)
    expect(Number(text)).toBeCloseTo(P_OK, 6)
    expect(lines.join('\n')).not.toContain(KEY)
    expect(lines.join('\n')).not.toContain(b64.slice(0, 40))
    // 中ほどの断片も出ない（PNG のヘッダは固定なので先頭だけでは弱い）
    const mid = Math.floor(b64.length / 2)
    expect(lines.join('\n')).not.toContain(b64.slice(mid, mid + 40))
    // HTTP のアクセスログは「METHOD path status ms sha12= size=」だけ
    const access = lines.filter((l) => /^(GET|POST|OPTIONS) /u.test(l))
    expect(access.length).toBeGreaterThan(0)
    for (const l of access) expect(l).toMatch(/^(GET|POST|OPTIONS) \S+ \d{3} \d+ms sha12=\S+ size=\d+$/u)
  })

  it('生バイト（image/png）でも同じ数値を返す', async () => {
    const fake = await startFake()
    const { url } = await startHarness(fake)
    const res = await fetch(`${url}/v1/check`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', ...AUTH },
      body: await pngOf('#ffffff'),
    })
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).toMatch(NUMBER_ONLY)
    expect(Number(text)).toBeCloseTo(P_OK, 6)
  })

  it('未処理（赤）の画像は低い値を返す', async () => {
    const fake = await startFake()
    const { url } = await startHarness(fake)
    const res = await fetch(`${url}/v1/check`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', ...AUTH },
      body: await pngOf('#ff0000'),
    })
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(Number(text)).toBeCloseTo(P_NG, 6)
    expect(Number(text)).toBeLessThan(0.1)
  })
})

describe('e2e: MCP /mcp', () => {
  it('check_mosaic の成功本文は数値のテキストだけ', async () => {
    const fake = await startFake()
    const { url } = await startHarness(fake)
    const client = new Client({ name: 'e2e', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: AUTH } }),
    )
    try {
      const result = await client.callTool({
        name: 'check_mosaic',
        arguments: { image_base64: (await pngOf('#ffffff')).toString('base64') },
      })
      const content = result.content as { type: string; text?: string }[]
      expect(result.isError).toBeFalsy()
      expect(content).toHaveLength(1)
      expect(content[0]?.type).toBe('text')
      expect(content[0]?.text).toMatch(NUMBER_ONLY)
      expect(Number(content[0]?.text)).toBeCloseTo(P_OK, 6)
    } finally {
      await client.close()
    }
  })

  it('判定モデルが落ちていると isError で、本文は error: 始まり（数値にならない）', async () => {
    const { url } = await startHarness({ url: await closedUrl() })
    const client = new Client({ name: 'e2e', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: AUTH } }),
    )
    try {
      const result = await client.callTool({
        name: 'check_mosaic',
        arguments: { image_base64: (await pngOf('#ffffff')).toString('base64') },
      })
      const content = result.content as { type: string; text?: string }[]
      expect(result.isError).toBe(true)
      expect(content[0]?.text?.startsWith('error:')).toBe(true)
      expect(Number.isNaN(Number(content[0]?.text))).toBe(true)
    } finally {
      await client.close()
    }
  })
})

describe('e2e: 判定モデル停止', () => {
  it('接続拒否で 502、数値は返さない', async () => {
    const { url } = await startHarness({ url: await closedUrl() })
    const res = await postJson(url, (await pngOf('#ffffff')).toString('base64'))
    const text = await res.text()
    expect(res.status).toBe(502)
    expect(JSON.parse(text)).toMatchObject({ error: 'vlm' })
    expect(text).not.toMatch(NUMBER_ONLY)
  })

  it('判定モデルが 500 を返しても 502、数値は返さない', async () => {
    const fake = await startFake()
    fake.mode = 'error'
    const { url } = await startHarness(fake)
    const res = await postJson(url, (await pngOf('#ffffff')).toString('base64'))
    const text = await res.text()
    expect(res.status).toBe(502)
    expect(JSON.parse(text)).toMatchObject({ error: 'vlm' })
    expect(text).not.toMatch(NUMBER_ONLY)
  })
})

describe('e2e: レイヤー付き PSD', () => {
  it('モザイク層を外した変種の最小値を返す（見えているとおりの合成は処理済みに見える）', async () => {
    const fake = await startFake()
    const { url } = await startHarness(fake)
    const res = await fetch(`${url}/v1/check`, {
      method: 'POST',
      headers: { 'content-type': 'image/vnd.adobe.photoshop', ...AUTH },
      body: psdWithMosaic(),
    })
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).toMatch(NUMBER_ONLY)
    expect(Number(text)).toBeCloseTo(P_NG, 6)
    expect(Number(text)).toBeLessThan(0.1)
  })

  it('PSD の上限ちょうどでは最後まで判定し、超過時は REST と MCP で必要件数を返す', async () => {
    const fake = await startFake((call) => call === 4 ? MASS_FORGOT : MASS_OK)
    const psd = Buffer.from(psdWithMosaic())
    const mime = 'image/vnd.adobe.photoshop'
    const accepted = await startHarness(fake, { maxRenders: 4 })
    const success = await postDetail(accepted.url, psd, mime)
    expect(success.status).toBe(200)
    const result = await success.json() as DetailBody
    expect(result.p_ok).toBeCloseTo(P_NG)
    expect(result.render).toBe('「背景」を外す')
    expect(fake.judgeCalls).toBe(4)
    const tokenized = fake.tokenizeCalls

    const capped = await startHarness(fake, { maxRenders: 3, maxFrames: 1, recheck: true })
    const response = await postDetail(capped.url, psd, mime)
    expect(response.status).toBe(413)
    const body = await response.json()
    expect(body).toEqual({
      error: 'too_large', reason: 'psd_render_limit', required_renders: 4, max_renders: 3,
      message: expect.stringMatching(/4件.*3件/),
    })
    const client = new Client({ name: 'e2e', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${capped.url}/mcp`), { requestInit: { headers: AUTH } }))
    try {
      const error = await client.callTool({
        name: 'check_mosaic',
        arguments: { image_base64: psd.toString('base64') },
      })
      expect(error.isError).toBe(true)
      expect(error.structuredContent).toEqual(body)
      expect(error.content).toEqual([{ type: 'text', text: expect.stringMatching(/^error: too_large: /) }])
    } finally {
      await client.close()
    }

    const frames = await Promise.all(['#ffffff', '#ff0000'].map(pngOf))
    const gif = await sharp(frames, { join: { animated: true } }).gif().toBuffer()
    const other = await postDetail(capped.url, gif, 'image/gif')
    expect(other.status).toBe(413)
    expect(await other.json()).toEqual({ error: 'too_large', message: expect.any(String) })
    expect(fake.judgeCalls).toBe(4)
    expect(fake.tokenizeCalls).toBe(tokenized)
    expect(fake.agentCalls).toBe(0)
  })
})

// 左 1/4 だけ赤の 128×128。全体の平均は白寄り（一次判定は処理済み）、左 1/4 の切り出しは赤（未処理）。
const quarterRedPng = () => {
  const n = 128
  const raw = Buffer.alloc(n * n * 3, 255)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n / 4; x++) {
      const i = (y * n + x) * 3
      raw[i + 1] = 0
      raw[i + 2] = 0
    }
  return sharp(raw, { raw: { width: n, height: n, channels: 3 } }).png().toBuffer()
}

describe('e2e: 再判定（RECHECK=1）', () => {
  it('エージェントが crop を呼び、切り出しの低い値で下げる（max_tokens と文脈長が実用の大きさ）', async () => {
    const fake = await startFake()
    // 範囲を全域にして、必ず再判定に入るようにする
    const { url } = await startHarness(fake, { recheck: true, recheckLo: 0, recheckHi: 1, recheckMaxCrops: 3 })
    const res = await fetch(`${url}/v1/check`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', ...AUTH },
      body: await quarterRedPng(),
    })
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).toMatch(NUMBER_ONLY)
    expect(fake.agentCalls).toBe(2) // crop の依頼 → 結果を受けて「完了」
    expect(fake.judgeCalls).toBe(2) // 一次判定 + 切り出しの判定
    expect(Number(text)).toBeCloseTo(P_NG, 6)
  })
})

describe('e2e: 公開とセキュリティ', () => {
  it('OPTIONS プリフライトは認証なしで 204 と CORS ヘッダを返す', async () => {
    const fake = await startFake()
    const { url } = await startHarness(fake)
    const res = await fetch(`${url}/v1/check`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://example.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
        'Access-Control-Request-Private-Network': 'true',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-private-network')).toBe('true')
  })

  it('認証が無い・違うキーは 401、数値は返さない', async () => {
    const fake = await startFake()
    const { url } = await startHarness(fake)
    const b64 = (await pngOf('#ffffff')).toString('base64')
    const none = await postJson(url, b64, {})
    expect(none.status).toBe(401)
    expect(none.headers.get('www-authenticate')).toBe('Bearer')
    const wrong = await postJson(url, b64, { Authorization: 'Bearer nope' })
    expect(wrong.status).toBe(401)
    expect(await wrong.text()).not.toMatch(NUMBER_ONLY)
  })

  it('/healthz は認証なしで ok', async () => {
    const fake = await startFake()
    const { url } = await startHarness(fake)
    const res = await fetch(`${url}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('許可外の接続元は 403。X-Forwarded-For を偽っても通らない', async () => {
    const fake = await startFake()
    const { url } = await startHarness(fake, { allowCidrs: ['10.0.0.0/8'] })
    const res = await postJson(url, (await pngOf('#ffffff')).toString('base64'), {
      ...AUTH,
      'X-Forwarded-For': '10.1.2.3',
    })
    const text = await res.text()
    expect(res.status).toBe(403)
    expect(text).not.toMatch(NUMBER_ONLY)
    const health = await fetch(`${url}/healthz`, { headers: { 'X-Forwarded-For': '10.1.2.3' } })
    expect(health.status).toBe(403)
  })

  it('ループバック以外に待ち受けるのにキーが無ければ起動を拒否する', async () => {
    const fake = await startFake()
    const cfg = defaultConfig({ bind: '0.0.0.0', apiKey: undefined, vlmBaseUrls: [fake.url], calibrationPath: NO_CAL })
    expect(() => buildServer(cfg, { log: () => undefined })).toThrow()
  })
})

describe('e2e: 同時実行', () => {
  it('2 件同時の要求は直列化され、判定モデルへの同時要求は 1 件まで', async () => {
    const fake = await startFake()
    fake.delayMs = 200
    const { url } = await startHarness(fake)
    const b64 = (await pngOf('#ffffff')).toString('base64')
    const [a, b] = await Promise.all([postJson(url, b64), postJson(url, b64)])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(fake.maxInFlight).toBe(1)
  })
})

describe('e2e: 複数台（VLM_BASE_URLS）', () => {
  it('片方の台が停止していても、もう片方で成功する（台を外して 1 回だけ再試行）', async () => {
    const live = await startFake()
    const dead = await closedUrl()
    const { url } = await startHarness({ url: '' }, { vlmBaseUrls: [dead, live.url] })
    const res = await postJson(url, (await pngOf('#ffffff')).toString('base64'))
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(Number(text)).toBeCloseTo(P_OK, 6)
    expect(live.judgeCalls).toBeGreaterThan(0)
  })

  it('2 台に振り分けられ、各台の同時要求は 1 件まで', async () => {
    const a = await startFake()
    const b = await startFake()
    a.delayMs = 150
    b.delayMs = 150
    const { url } = await startHarness({ url: '' }, { vlmBaseUrls: [a.url, b.url] })
    const b64 = (await pngOf('#ffffff')).toString('base64')
    const results = await Promise.all([1, 2, 3, 4].map(() => postJson(url, b64)))
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200])
    expect(a.judgeCalls).toBeGreaterThan(0)
    expect(b.judgeCalls).toBeGreaterThan(0)
    expect(a.maxInFlight).toBe(1)
    expect(b.maxInFlight).toBe(1)
  })
})

describe('e2e: 切断と MCP の上限', () => {
  it('切断後は判定の要求が増えず、次の要求が通る（PSD の描画を途中で打ち切る）', async () => {
    const fake = await startFake()
    fake.delayMs = 300
    const { url } = await startHarness(fake)
    const ac = new AbortController()
    const pending = fetch(`${url}/v1/check`, {
      method: 'POST',
      headers: { 'content-type': 'image/vnd.adobe.photoshop', ...AUTH },
      body: psdWithMosaic(),
      signal: ac.signal,
    }).catch((e: unknown) => e)
    await sleep(400)
    ac.abort()
    await pending
    await sleep(100)
    const atAbort = fake.judgeCalls
    await sleep(1000)
    expect(fake.judgeCalls).toBe(atAbort)
    const res = await fetch(`${url}/v1/check`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', ...AUTH },
      body: await pngOf('#ffffff'),
    })
    expect(res.status).toBe(200)
  })

  it('MCP で 5 MiB を超える画像（base64 で約 9 MB）も通る', async () => {
    const fake = await startFake()
    const { url } = await startHarness(fake)
    const png = await sharp(randomBytes(1500 * 1500 * 3), { raw: { width: 1500, height: 1500, channels: 3 } })
      .png()
      .toBuffer()
    expect(png.length).toBeGreaterThan(4 * 1024 * 1024)
    const client = new Client({ name: 'e2e', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: AUTH } }))
    try {
      const result = await client.callTool({ name: 'check_mosaic', arguments: { image_base64: png.toString('base64') } })
      const text = (result.content as { text?: string }[])[0]?.text ?? ''
      expect(result.isError).toBeFalsy()
      expect(text).toMatch(NUMBER_ONLY)
    } finally {
      await client.close()
    }
  })

  it('MCP の巨大本文は、溜める前に 413（判定は呼ばれない）', async () => {
    const fake = await startFake()
    const { url } = await startHarness(fake)
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'check_mosaic', arguments: { image_base64: 'A'.repeat(21 * 1024 * 1024) } },
    })
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...AUTH },
      body,
    })
    expect(res.status).toBe(413)
    expect(fake.judgeCalls).toBe(0)
  })

  it('MCP: 復号後に上限を超える画像は isError（判定は呼ばれない）', async () => {
    const fake = await startFake()
    // 上限 1048 バイト。本文の上限（base64 と JSON の余裕）には入るが、復号後は超える
    const { url } = await startHarness(fake, { maxImageMb: 0.001 })
    const client = new Client({ name: 'e2e', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: AUTH } }))
    try {
      const result = await client.callTool({
        name: 'check_mosaic',
        arguments: { image_base64: randomBytes(1100).toString('base64') },
      })
      const text = (result.content as { text?: string }[])[0]?.text ?? ''
      expect(result.isError).toBe(true)
      expect(text.startsWith('error:')).toBe(true)
      expect(fake.judgeCalls).toBe(0)
    } finally {
      await client.close()
    }
  })
})

type DetailBody = { p_ok: number; judgment: string; confidence: number; render: string; classes: Record<'ok' | 'forgot' | 'nori', number>; per_model: Record<string, Probs4>; detect?: unknown }
const CLASS_KEYS = ['forgot', 'nori', 'ok']

async function postDetail(url: string, bytes: Uint8Array, mime: string, query = 'detail=1') {
  return fetch(`${url}/v1/check?${query}`, {
    method: 'POST',
    headers: { 'content-type': mime, ...AUTH },
    body: new Uint8Array(bytes),
  })
}

describe('e2e: 詳細（detail）', () => {
  it('REST の detail=1 は p_ok・描画の説明・統合後とモデル別の確率を JSON で返す', async () => {
    const fake = await startFake()
    const { url, lines } = await startHarness(fake)
    const res = await postDetail(url, await pngOf('#ff0000'), 'image/png')
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = JSON.parse(text) as DetailBody
    expect(Object.keys(body).sort()).toEqual(['classes', 'confidence', 'judgment', 'p_ok', 'per_model', 'render'])
    expect(body.judgment).toBe('forgot')
    expect(body.confidence).toBeCloseTo(0.95, 6)
    expect(Object.keys(body.classes).sort()).toEqual([...CLASS_KEYS].sort())
    expect(body.p_ok).toBeCloseTo(P_NG, 6)
    expect(body.render).toBe('ラスター')
    expect(body.classes.forgot).toBeCloseTo(0.95, 6)
    expect(body.classes.nori).toBeCloseTo(0.02, 6)
    expect(body.classes.ok).toBeCloseTo(0.03, 6)
    expect(body.per_model.default?.none).toBeCloseTo(0.01, 6)
    expect(lines.join('\n')).not.toContain(KEY)
  })

  it('PSD の detail は最悪の描画（モザイク層を外した描画）の説明と、その種類の確率を返す', async () => {
    const fake = await startFake()
    const { url } = await startHarness(fake)
    const res = await postDetail(url, Buffer.from(psdWithMosaic()), 'image/vnd.adobe.photoshop')
    const body = JSON.parse(await res.text()) as DetailBody
    expect(res.status).toBe(200)
    expect(body.render).toBe('モザイク名のレイヤーを非表示')
    expect(body.p_ok).toBeCloseTo(P_NG, 6)
    expect(body.classes.forgot).toBeCloseTo(0.95, 6)
  })

  it('detail=true も詳細を返し、既定（detail 無し・detail=0）は数値だけのまま', async () => {
    const fake = await startFake()
    const { url } = await startHarness(fake)
    const png = await pngOf('#ffffff')
    const asTrue = JSON.parse(await (await postDetail(url, png, 'image/png', 'detail=true')).text()) as DetailBody
    expect(asTrue.p_ok).toBeCloseTo(P_OK, 6)
    // 既定（クエリ無し）と detail=0 は数値 1 個だけ
    const plain = await fetch(`${url}/v1/check`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', ...AUTH },
      body: png,
    })
    const zero = await postDetail(url, png, 'image/png', 'detail=0')
    for (const res of [plain, zero]) {
      const text = await res.text()
      expect(res.status).toBe(200)
      expect(text).toMatch(NUMBER_ONLY)
      expect(Number(text)).toBeCloseTo(P_OK, 6)
    }
  })

  it('黒い枠（ノリ）は nori として NG 側に入る', async () => {
    const fake = await startFake()
    const { url } = await startHarness(fake)
    const res = await postDetail(url, await pngOf('#000000'), 'image/png')
    const body = await res.json() as DetailBody
    expect(body.judgment).toBe('nori')
    expect(body.p_ok).toBeCloseTo(P_NG, 6)
    expect(body.classes.nori).toBeCloseTo(0.95, 6)
    expect(body.classes.ok).toBeCloseTo(0.03, 6)
  })

  it('MCP の detail: true は同じ詳細 JSON の文字列を 1 要素で返す', async () => {
    const fake = await startFake()
    const { url } = await startHarness(fake)
    const client = new Client({ name: 'e2e', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: AUTH } }))
    try {
      const result = await client.callTool({
        name: 'check_mosaic',
        arguments: { image_base64: (await pngOf('#ff0000')).toString('base64'), detail: true },
      })
      const content = result.content as { type: string; text?: string }[]
      expect(result.isError).toBeFalsy()
      expect(content).toHaveLength(1)
      expect(content[0]?.type).toBe('text')
      const body = JSON.parse(content[0]?.text ?? '') as DetailBody
      expect(body.p_ok).toBeCloseTo(P_NG, 6)
      expect(body.render).toBe('ラスター')
      expect(body.classes.forgot).toBeCloseTo(0.95, 6)
    } finally {
      await client.close()
    }
  })

  it('判定モデルが停止していると detail でも失敗。数値も JSON も返さない（REST は 502、MCP は isError）', async () => {
    const dead = await startHarness({ url: await closedUrl() })
    const png = await pngOf('#ffffff')
    const res = await postDetail(dead.url, png, 'image/png')
    const text = await res.text()
    expect(res.status).toBe(502)
    expect(JSON.parse(text)).toMatchObject({ error: 'vlm' })
    expect(text).not.toMatch(NUMBER_ONLY)
    expect(text).not.toContain('p_ok')

    const client = new Client({ name: 'e2e', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${dead.url}/mcp`), { requestInit: { headers: AUTH } }))
    try {
      const result = await client.callTool({
        name: 'check_mosaic',
        arguments: { image_base64: png.toString('base64'), detail: true },
      })
      const mtext = (result.content as { text?: string }[])[0]?.text ?? ''
      expect(result.isError).toBe(true)
      expect(mtext.startsWith('error:')).toBe(true)
      expect(mtext).not.toContain('p_ok')
      expect(Number.isNaN(Number(mtext))).toBe(true)
    } finally {
      await client.close()
    }
  })
})

describe('e2e: fields の 3 パターン（judgment のみ / confidence のみ / 両方）', () => {
  it('REST: 3 パターンを実パイプラインで選べる', async () => {
    const fake = await startFake()
    const { url, lines } = await startHarness(fake)
    const png = await pngOf('#ff0000')
    const get = async (query: string) => {
      const res = await postDetail(url, png, 'image/png', query)
      expect(res.status, query).toBe(200)
      return JSON.parse(await res.text()) as Record<string, unknown>
    }

    const only = await get('fields=judgment')
    expect(Object.keys(only)).toEqual(['p_ok', 'judgment'])
    expect(only.judgment).toBe('forgot')

    const conf = await get('fields=confidence')
    expect(Object.keys(conf)).toEqual(['p_ok', 'confidence'])
    expect(conf.confidence as number).toBeCloseTo(0.95, 6)

    const both = await get('fields=judgment,confidence')
    expect(Object.keys(both)).toEqual(['p_ok', 'judgment', 'confidence'])
    expect(both.judgment).toBe('forgot')
    expect(both.confidence as number).toBeCloseTo(0.95, 6)
    // p_ok は 3 パターンとも同じ値
    expect(only.p_ok).toBe(conf.p_ok)
    expect(conf.p_ok).toBe(both.p_ok)
    expect(lines.join('\n')).not.toContain(KEY)
  })

  it('REST: 不正な fields は 400 で、判定サーバーに問い合わせない', async () => {
    const fake = await startFake()
    const { url } = await startHarness(fake)
    const before = fake.judgeCalls
    const res = await postDetail(url, await pngOf('#ff0000'), 'image/png', 'fields=per_model')
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('p_ok')
    expect(fake.judgeCalls).toBe(before)
  })
})

describe('e2e: v1.1 のモデル統合とアニメーション', () => {
  it('全モデルの確率を重み付きで平均してから式を適用する。片方の失敗は 502', async () => {
    const first = await startFake()
    const second = await startFake()
    first.fixedMass = { none: 0.2, processed: 0.4, forgot: 0.3, nori: 0.1 }
    second.fixedMass = { none: 0.1, processed: 0.1, forgot: 0.1, nori: 0.7 }
    const { url } = await startHarness(first, { judges: [
      { name: 'x', model: 'model-x', urls: [first.url], slots: 2, weight: 1 },
      { name: 'y', model: 'model-y', urls: [second.url], slots: 2, weight: 2 },
    ] })
    const png = await pngOf('#ffffff')
    const response = await postDetail(url, png, 'image/png')
    expect(response.status).toBe(200)
    const body = await response.json() as DetailBody
    // OK は 1.0/3、forgot は 0.5/3、nori は 1.5/3。
    expect(body.p_ok).toBeCloseTo(0.4)
    expect(body.judgment).toBe('nori')
    expect(body.confidence).toBeCloseTo(0.5)
    expect(body.per_model.x?.forgot).toBeCloseTo(0.3)
    expect(body.per_model.y?.nori).toBeCloseTo(0.7)
    expect([first.judgeCalls, second.judgeCalls]).toEqual([1, 1])

    second.mode = 'error'
    const failed = await postDetail(url, png, 'image/png', 'detail=0')
    expect(failed.status).toBe(502)
    const error = await failed.json()
    expect(error).toMatchObject({ error: 'vlm' })
    expect(error).not.toHaveProperty('p_ok')
  })

  it.each(['gif', 'webp'] as const)('%s は10秒ちょうどの後半フレームまで判定する', async (format) => {
    const fake = await startFake()
    const { url } = await startHarness(fake, { maxRenders: 2 })
    const colors = ['#ffffff', '#6fde8f', '#8888ff', '#ff0000']
    const frames = await Promise.all(colors.map(pngOf))
    const image = await sharp(frames, { join: { animated: true } })[format]({ delay: [2500, 2500, 2500, 2500] }).toBuffer()
    const res = await postDetail(url, image, `image/${format}`)
    expect(res.status).toBe(200)
    const body = await res.json() as DetailBody
    expect(body.render).toBe('フレーム 4/4')
    expect(body.p_ok).toBeCloseTo(P_NG)
    expect(fake.judgeCalls).toBe(4)
  })

  it('2モデルがそれぞれ2スロットで全フレームを判定する', async () => {
    const first = await startFake()
    const second = await startFake()
    first.delayMs = second.delayMs = 60
    const { url } = await startHarness(first, { judges: [
      { name: 'x', model: 'model-x', urls: [first.url], slots: 2, weight: 1 },
      { name: 'y', model: 'model-y', urls: [second.url], slots: 2, weight: 1 },
    ] })
    const frames = await Promise.all(['#ffffff', '#6fde8f', '#8888ff', '#ff0000'].map(pngOf))
    const gif = await sharp(frames, { join: { animated: true } }).gif().toBuffer()
    const res = await postDetail(url, gif, 'image/gif')
    expect(res.status).toBe(200)
    expect([first.judgeCalls, second.judgeCalls]).toEqual([4, 4])
    expect([first.maxInFlight, second.maxInFlight]).toEqual([2, 2])
  })

  it('フレーム数または再生時間を超過したら、推論前に 413 を返す', async () => {
    const fake = await startFake()
    const frames = await Promise.all(['#ffffff', '#8888ff'].map(pngOf))
    const gif = await sharp(frames, { join: { animated: true } }).gif({ delay: [5000, 5010] }).toBuffer()
    for (const limits of [{ maxFrames: 1, maxAnimSeconds: 11 }, { maxFrames: 2, maxAnimSeconds: 10 }]) {
      const { url } = await startHarness(fake, limits)
      const res = await postDetail(url, gif, 'image/gif')
      expect(res.status).toBe(413)
      expect(await res.json()).toMatchObject({ error: 'too_large' })
    }
    expect(fake.judgeCalls).toBe(0)
  })
})

describe('e2e: 前段の検出（DETECT=1、偽の検出器と本物の切り出し）', () => {
  const DET: Partial<Config> = { detect: true, detectMargin: 0, detectMinSide: 1 }
  const MARK = '987.654'
  const quarterBox: Detector = async () => ({ boxes: [{ x0: 0, y0: 0, x1: 32, y1: 128, label: 'penis', score: 0.9 }] })

  it('左 1/4 の箱を切り出して判定し、全体が処理済みでも forgot の値と切り出しの render を返す（判定はちょうど 2 回）', async () => {
    const fake = await startFake()
    const { url } = await startHarness(fake, DET, quarterBox)
    const res = await postDetail(url, await quarterRedPng(), 'image/png')
    const body = JSON.parse(await res.text()) as DetailBody
    expect(res.status).toBe(200)
    expect(body.p_ok).toBeCloseTo(P_NG, 6)
    expect(body.judgment).toBe('forgot')
    // ラスターの PNG の描画名は「ラスター」（PSD の合成なら「見えているとおり」）
    expect(body.render).toBe('ラスターの切り出し 1')
    expect(fake.judgeCalls).toBe(2)
    // 検出の箱と寸法（分類器なし）
    expect(body.detect).toEqual({ style: null, p_real: null, width: 128, height: 128, boxes: [{ label: 'penis', score: 0.9, x0: 0, y0: 0, x1: 32, y1: 128 }] })

    // DETECT=0 なら同じ画像は処理済みで、detect は無い
    const off = await startHarness(fake)
    const plain = await postDetail(off.url, await quarterRedPng(), 'image/png')
    const offBody = JSON.parse(await plain.text()) as DetailBody
    expect(offBody.p_ok).toBeCloseTo(P_OK, 6)
    expect('detect' in offBody).toBe(false)
  })

  it('起動時に 1 行だけ出し、ログには座標もパスも出さない。アクセスログの書式は変わらない', async () => {
    const fake = await startFake()
    const spec = { model: join(tmpdir(), 'PATHMARK', 'anime.onnx'), sha256: undefined, labels: undefined, classes: ['penis'], threshold: 0.3, resize: 'stretch' as const }
    // 座標は応答に返るので、目印はスコア（0.987654）に置く
    const marked: Detector = async () => ({ boxes: [{ x0: 0, y0: 0, x1: 32, y1: 128, label: 'penis', score: Number(MARK) / 1000 }] })
    const { url, lines } = await startHarness(fake, { ...DET, detectAnime: spec }, marked)
    const res = await postDetail(url, await quarterRedPng(), 'image/png')
    expect(res.status).toBe(200)
    expect((JSON.parse(await res.text()) as DetailBody).p_ok).toBeCloseTo(P_NG, 6)
    expect(lines.filter((l) => l.startsWith('前段の検出'))).toEqual(['前段の検出: 有効（検出器 1、分類器なし）'])
    for (const l of lines) {
      expect(l).not.toContain(MARK)
      expect(l).not.toContain('987654')
      expect(l).not.toContain('PATHMARK')
    }
    const access = lines.filter((l) => /^(GET|POST|OPTIONS) /u.test(l))
    expect(access).toHaveLength(1)
    for (const l of access) expect(l).toMatch(/^(GET|POST|OPTIONS) \S+ \d{3} \d+ms sha12=\S+ size=\d+$/u)

    // DETECT=0 では出さない
    const off = await startHarness(fake)
    expect(off.lines.some((l) => l.startsWith('前段の検出'))).toBe(false)
  })

  it('失敗: 検出の失敗は 500、切り出しの判定の失敗は 502。どちらも本文に p_ok も目印もない', async () => {
    const fake = await startFake()
    const broken: Detector = async () => {
      throw new Error(`PATHMARK ${MARK}`)
    }
    const failing = await startHarness(fake, DET, broken)
    const res = await postDetail(failing.url, await quarterRedPng(), 'image/png')
    const text = await res.text()
    expect(res.status).toBe(500)
    expect(JSON.parse(text)).toMatchObject({ error: 'internal' })
    for (const s of ['p_ok', 'PATHMARK', MARK]) expect(text).not.toContain(s)
    expect(failing.lines.join('\n')).not.toContain('PATHMARK')

    // 全体の判定のあとで判定サーバーを落とす → 切り出しの判定が失敗する
    const down: Detector = async (png, signal) => {
      fake.mode = 'error'
      return quarterBox(png, signal)
    }
    const vlm = await startHarness(fake, DET, down)
    const res2 = await postDetail(vlm.url, await quarterRedPng(), 'image/png')
    const text2 = await res2.text()
    expect(res2.status).toBe(502)
    expect(JSON.parse(text2)).toMatchObject({ error: 'vlm' })
    expect(text2).not.toContain('p_ok')
  })

  it('起動: DETECT=1 で crops がない、または較正が a ≤ 0 なら buildServer が投げる', async () => {
    const fake = await startFake()
    await expect(startHarness(fake, DET)).rejects.toThrow(/DETECT=1/u)
    const path = join(tmpdir(), `mosaic-e2e-bad-calibration-${process.pid}.json`)
    writeFileSync(path, JSON.stringify({ version: 'v1.1', a: -0.5, b: 0 }))
    closers.push(async () => rmSync(path, { force: true }))
    await expect(startHarness(fake, { ...DET, calibrationPath: path }, quarterBox)).rejects.toThrow(/DETECT=1/u)
    // DETECT=0 なら同じ較正で起動できる
    await expect(startHarness(fake, { calibrationPath: path })).resolves.toBeDefined()
  })
})
