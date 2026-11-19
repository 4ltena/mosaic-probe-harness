import { type AddressInfo, connect } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpServer, type Handlers } from '../src/http.ts'
import { defaultConfig } from '../src/config.ts'
import { CheckError, type Detail, HTTP_STATUS_OF_KIND } from '../src/types.ts'

const LOOPBACK = ['127.0.0.0/8', '::1/128']
const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

async function start(
  overrides: Parameters<typeof defaultConfig>[0],
  h: Handlers,
): Promise<{ base: string; logs: string[] }> {
  const cfg = defaultConfig({ allowCidrs: LOOPBACK, corsOrigins: [], ...overrides })
  const logs: string[] = []
  const server = createHttpServer(cfg, h, (l) => logs.push(l))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  closers.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  )
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, logs }
}

const okCheck = async () => 0.5

describe('createHttpServer', () => {
  it('許可外 IP は 403（X-Forwarded-For があっても）', async () => {
    const { base } = await start({ allowCidrs: ['10.0.0.0/8'] }, { check: okCheck })
    // XFF が許可内の値でも、実接続（127.0.0.1）が許可外なら 403
    const r = await fetch(`${base}/healthz`, { headers: { 'X-Forwarded-For': '10.1.2.3' } })
    expect(r.status).toBe(403)
  })

  it('OPTIONS は認証なしで 204 と CORS ヘッダ', async () => {
    const { base } = await start({ apiKey: 'k', corsOrigins: '*' }, { check: okCheck })
    const r = await fetch(`${base}/v1/check`, { method: 'OPTIONS' })
    expect(r.status).toBe(204)
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    expect(r.headers.get('access-control-allow-methods')).toContain('POST')
  })

  it('/healthz は認証なしで ok', async () => {
    const { base } = await start({ apiKey: 'k' }, { check: okCheck })
    const r = await fetch(`${base}/healthz`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('ok')
  })

  it('認証: 無い・違う → 401 + WWW-Authenticate、check は呼ばれない', async () => {
    let calls = 0
    const { base } = await start({ apiKey: 'k' }, { check: async () => (calls++, 0.1) })
    const none = await fetch(`${base}/v1/check`, { method: 'POST', body: 'abc' })
    expect(none.status).toBe(401)
    expect(none.headers.get('www-authenticate')).toBe('Bearer')
    const wrong = await fetch(`${base}/v1/check`, { method: 'POST', body: 'abc', headers: { Authorization: 'Bearer x' } })
    expect(wrong.status).toBe(401)
    expect(calls).toBe(0)
    const ok = await fetch(`${base}/v1/check`, { method: 'POST', body: 'abc', headers: { Authorization: 'Bearer k' } })
    expect(ok.status).toBe(200)
    expect(calls).toBe(1)
  })

  it('生バイトの POST は本文をそのまま渡し、数値を JSON で返す', async () => {
    let got: Uint8Array | undefined
    const { base } = await start({}, { check: async (b) => ((got = b), 0.25) })
    const bytes = new Uint8Array([1, 2, 3, 250])
    const r = await fetch(`${base}/v1/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: bytes,
    })
    expect(r.status).toBe(200)
    expect(await r.text()).toBe(JSON.stringify(0.25))
    expect(Array.from(got!)).toEqual([1, 2, 3, 250])
  })

  it('JSON の image_base64（data: 接頭辞・改行あり）を復号して渡す', async () => {
    let got: Uint8Array | undefined
    const { base } = await start({}, { check: async (b) => ((got = b), 0.7) })
    const b64 = Buffer.from('PNGDATA').toString('base64')
    const body = JSON.stringify({ image_base64: `data:image/png;base64,${b64.slice(0, 4)}\n${b64.slice(4)}` })
    const r = await fetch(`${base}/v1/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    expect(r.status).toBe(200)
    expect(Buffer.from(got!).toString()).toBe('PNGDATA')
  })

  it('JSON が不正・フィールド無しは 400', async () => {
    const { base } = await start({}, { check: okCheck })
    const bad = await fetch(`${base}/v1/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })
    expect(bad.status).toBe(400)
    const missing = await fetch(`${base}/v1/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"x":1}' })
    expect(missing.status).toBe(400)
  })

  it('上限超過は 413 で、check は呼ばれない', async () => {
    let calls = 0
    const { base } = await start({ maxImageMb: 0.001 }, { check: async () => (calls++, 0.1) })
    const r = await fetch(`${base}/v1/check`, { method: 'POST', body: new Uint8Array(5000) })
    expect(r.status).toBe(413)
    expect(calls).toBe(0)
  })

  it('CheckError は kind に応じた状態、busy は Retry-After: 5', async () => {
    for (const kind of ['bad_input', 'unsupported', 'vlm', 'busy', 'internal'] as const) {
      const { base } = await start({}, { check: async () => { throw new CheckError(kind, 'msg') } })
      const r = await fetch(`${base}/v1/check`, { method: 'POST', body: 'x' })
      expect(r.status).toBe(HTTP_STATUS_OF_KIND[kind])
      const body = (await r.json()) as { error: string }
      expect(body.error).toBe(kind)
      if (kind === 'busy') expect(r.headers.get('retry-after')).toBe('5')
    }
  })

  it('非有限・範囲外の戻り値は 500 で数値を返さない', async () => {
    for (const v of [NaN, Infinity, -0.1, 1.5]) {
      const { base } = await start({}, { check: async () => v })
      const r = await fetch(`${base}/v1/check`, { method: 'POST', body: 'x' })
      expect(r.status).toBe(500)
      expect(await r.text()).not.toMatch(/^[0-9.]+$/)
    }
  })

  it('CheckError 以外の例外は 500 に包み、内部メッセージを出さない', async () => {
    const { base } = await start({}, { check: async () => { throw new Error('SECRETLEAK') } })
    const r = await fetch(`${base}/v1/check`, { method: 'POST', body: 'x' })
    expect(r.status).toBe(500)
    expect(await r.text()).not.toContain('SECRETLEAK')
  })

  it('/mcp は認証後に h.mcp へ委譲、無ければ 404', async () => {
    // 上限つきで読んだ JSON 本文が第 3 引数で渡る
    const mcp = async (_req: IncomingMessage, res: ServerResponse, parsed?: unknown) => {
      res.writeHead(200)
      res.end(`mcp-ok:${(parsed as { method: string }).method}`)
    }
    const { base } = await start({ apiKey: 'k' }, { check: okCheck, mcp })
    const json = { 'content-type': 'application/json' }
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: json, body: '{"method":"x"}' })).status).toBe(401)
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...json, Authorization: 'Bearer k' },
      body: '{"method":"tools/list"}',
    })
    expect(await r.text()).toBe('mcp-ok:tools/list')
    const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...json, Authorization: 'Bearer k' }, body: '{' })
    expect(bad.status).toBe(400)
    const none = await start({}, { check: okCheck })
    expect((await fetch(`${none.base}/mcp`, { method: 'POST' })).status).toBe(404)
  })

  it('/mcp の本文が上限（MAX_IMAGE_MB の base64 相当）を超えたら 413、h.mcp は呼ばれない', async () => {
    let called = 0
    const mcp = async (_req: IncomingMessage, res: ServerResponse) => {
      called++
      res.end('x')
    }
    const { base } = await start({ apiKey: 'k', maxImageMb: 0.001 }, { check: okCheck, mcp })
    const body = JSON.stringify({ method: 'tools/call', pad: 'A'.repeat(4096) })
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer k' },
      body,
    })
    expect(r.status).toBe(413)
    expect(called).toBe(0)
  })

  it('未知のパスは 404、メソッド違いは 405', async () => {
    const { base } = await start({}, { check: okCheck })
    expect((await fetch(`${base}/nope`)).status).toBe(404)
    expect((await fetch(`${base}/v1/check`)).status).toBe(405)
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(405)
  })

  it('すべての応答（エラー含む）に CORS ヘッダ', async () => {
    const { base } = await start({ apiKey: 'k', corsOrigins: '*' }, { check: okCheck })
    const statuses = [
      await fetch(`${base}/v1/check`, { method: 'POST' }),
      await fetch(`${base}/nope`, { headers: { Authorization: 'Bearer k' } }),
    ]
    for (const r of statuses) expect(r.headers.get('access-control-allow-origin')).toBe('*')
    const denied = await start({ allowCidrs: ['10.0.0.0/8'], corsOrigins: '*' }, { check: okCheck })
    const forbidden = await fetch(`${denied.base}/v1/check`, { method: 'POST' })
    expect(forbidden.status).toBe(403)
    expect(forbidden.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('許可外 IP の OPTIONS プリフライトは 403', async () => {
    const { base } = await start({ allowCidrs: ['10.0.0.0/8'], corsOrigins: '*' }, { check: okCheck })
    const r = await fetch(`${base}/v1/check`, { method: 'OPTIONS' })
    expect(r.status).toBe(403)
  })

  it('許可していない Origin には CORS ヘッダを付けない', async () => {
    const { base } = await start({ corsOrigins: ['http://a.test'] }, { check: okCheck })
    const ok = await fetch(`${base}/healthz`, { headers: { Origin: 'http://a.test' } })
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://a.test')
    const ng = await fetch(`${base}/healthz`, { headers: { Origin: 'http://b.test' } })
    expect(ng.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('プリフライトの Private-Network 要求に Allow-Private-Network を返す', async () => {
    const { base } = await start({ corsOrigins: '*' }, { check: okCheck })
    const r = await fetch(`${base}/v1/check`, {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Private-Network': 'true' },
    })
    expect(r.headers.get('access-control-allow-private-network')).toBe('true')
  })

  it('JSON 経路の上限超過も 413 で、check は呼ばれない', async () => {
    let calls = 0
    const { base } = await start({ maxImageMb: 0.001 }, { check: async () => (calls++, 0.1) })
    const r = await fetch(`${base}/v1/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: 'A'.repeat(5000) }),
    })
    expect(r.status).toBe(413)
    expect(calls).toBe(0)
  })

  it('解釈できない request-target でプロセスが落ちず、以後も応答する', async () => {
    const { base } = await start({}, { check: okCheck })
    const port = Number(new URL(base).port)
    const raw = await new Promise<string>((resolve, reject) => {
      let buf = ''
      const s = connect(port, '127.0.0.1', () => s.write('GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'))
      s.on('data', (d: Buffer) => (buf += d.toString()))
      s.on('close', () => resolve(buf))
      s.on('error', reject)
    })
    expect(raw).toMatch(/^HTTP\/1\.1 (400|404) /)
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
  })

  it('ログは 1 行で本文・キーを含まない', async () => {
    const { base, logs } = await start({ apiKey: 'KEYMARK' }, { check: okCheck })
    await fetch(`${base}/v1/check`, {
      method: 'POST',
      headers: { Authorization: 'Bearer KEYMARK' },
      body: 'PAYLOADMARK',
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/POST \/v1\/check 200 \d+ms sha12=[0-9a-f]{12} size=11/)
    expect(logs[0]).not.toContain('PAYLOADMARK')
    expect(logs[0]).not.toContain('KEYMARK')
  })

  it('クライアントが切断すると signal が abort される', async () => {
    let started!: () => void
    const startedP = new Promise<void>((r) => (started = r))
    let aborted!: () => void
    const abortedP = new Promise<void>((r) => (aborted = r))
    const check = (_b: Uint8Array, signal: AbortSignal) =>
      new Promise<number>((_, reject) => {
        started()
        signal.addEventListener('abort', () => {
          aborted()
          reject(new Error('aborted'))
        })
      })
    const { base } = await start({}, { check })
    const ac = new AbortController()
    const req = fetch(`${base}/v1/check`, { method: 'POST', body: 'x', signal: ac.signal }).catch(() => undefined)
    await startedP
    ac.abort()
    await req
    await abortedP
  })
})

const DETAIL: Detail = {
  pOk: 0.12,
  judgment: 'forgot',
  confidence: 0.82,
  render: 'モザイク名のレイヤーを非表示',
  classes: { ok: 0.11, forgot: 0.82, nori: 0.07 },
  perModel: { default: { none: 0.01, processed: 0.1, forgot: 0.82, nori: 0.07 } },
}
const DETAIL_BODY = {
  p_ok: 0.12,
  judgment: 'forgot',
  confidence: 0.82,
  render: 'モザイク名のレイヤーを非表示',
  classes: { ok: 0.11, forgot: 0.82, nori: 0.07 },
  per_model: DETAIL.perModel,
}

describe('createHttpServer detail', () => {
  it('?detail=1 は詳細 JSON（p_ok・render・classes と per_model）を返す', async () => {
    let detailCalls = 0
    let checkCalls = 0
    const { base } = await start(
      {},
      {
        check: async () => (checkCalls++, 0.5),
        checkDetail: async () => (detailCalls++, DETAIL),
      },
    )
    const r = await fetch(`${base}/v1/check?detail=1`, { method: 'POST', body: new Uint8Array([1, 2, 3]) })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('application/json')
    expect(await r.json()).toEqual(DETAIL_BODY)
    expect(detailCalls).toBe(1)
    expect(checkCalls).toBe(0)
  })

  it('?detail=true も詳細を返す', async () => {
    const { base } = await start({}, { check: okCheck, checkDetail: async () => DETAIL })
    const r = await fetch(`${base}/v1/check?detail=true`, { method: 'POST', body: 'x' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual(DETAIL_BODY)
  })

  it('JSON の image_base64 でも ?detail=1 が効く', async () => {
    let got: Uint8Array | undefined
    const { base } = await start(
      {},
      {
        check: okCheck,
        checkDetail: async (b) => ((got = b), DETAIL),
      },
    )
    const body = JSON.stringify({ image_base64: Buffer.from('PNGDATA').toString('base64') })
    const r = await fetch(`${base}/v1/check?detail=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual(DETAIL_BODY)
    expect(Buffer.from(got!).toString()).toBe('PNGDATA')
  })

  it('detail=0 や detail 無しは数値だけ（checkDetail は呼ばれない）', async () => {
    let detailCalls = 0
    const { base } = await start(
      {},
      {
        check: async () => 0.33,
        checkDetail: async () => (detailCalls++, DETAIL),
      },
    )
    for (const url of [`${base}/v1/check?detail=0`, `${base}/v1/check`, `${base}/v1/check?detail=yes`]) {
      const r = await fetch(url, { method: 'POST', body: 'x' })
      expect(r.status).toBe(200)
      expect(await r.text()).toBe(JSON.stringify(0.33))
    }
    expect(detailCalls).toBe(0)
  })

  it('checkDetail が無い状態で ?detail=1 は 501', async () => {
    const { base } = await start({}, { check: okCheck })
    const r = await fetch(`${base}/v1/check?detail=1`, { method: 'POST', body: 'x' })
    expect(r.status).toBe(501)
    expect(await r.json()).toEqual({ error: 'not_implemented' })
  })

  it('詳細の範囲外・非有限の値は 500 で、JSON も数値も返さない', async () => {
    const bads: Detail[] = [
      { ...DETAIL, pOk: 1.5 },
      { ...DETAIL, pOk: NaN },
      { ...DETAIL, classes: { ...DETAIL.classes, forgot: -0.1 } },
      { ...DETAIL, classes: { ...DETAIL.classes, nori: Infinity } },
      { ...DETAIL, confidence: 1.5 },
      { ...DETAIL, judgment: 'unknown' as Detail['judgment'] },
    ]
    for (const bad of bads) {
      const { base } = await start({}, { check: okCheck, checkDetail: async () => bad })
      const r = await fetch(`${base}/v1/check?detail=1`, { method: 'POST', body: 'x' })
      expect(r.status).toBe(500)
      const text = await r.text()
      expect(text).toBe(JSON.stringify({ error: 'internal' }))
      expect(text).not.toContain('p_ok')
    }
  })

  it('詳細の CheckError は kind に応じた状態で、p_ok を含まない', async () => {
    const { base } = await start(
      {},
      {
        check: okCheck,
        checkDetail: async () => {
          throw new CheckError('vlm', 'upstream')
        },
      },
    )
    const r = await fetch(`${base}/v1/check?detail=1`, { method: 'POST', body: 'x' })
    expect(r.status).toBe(502)
    const body = (await r.json()) as Record<string, unknown>
    expect(body.error).toBe('vlm')
    expect(body).not.toHaveProperty('p_ok')
  })

  it('詳細の CheckError 以外の例外は 500 に包み、内部メッセージを出さない', async () => {
    const { base } = await start(
      {},
      {
        check: okCheck,
        checkDetail: async () => {
          throw new Error('SECRETLEAK')
        },
      },
    )
    const r = await fetch(`${base}/v1/check?detail=1`, { method: 'POST', body: 'x' })
    expect(r.status).toBe(500)
    expect(await r.text()).not.toContain('SECRETLEAK')
  })
})

describe('createHttpServer fields（返す項目の選択）', () => {
  const post = async (query: string, h: Partial<Handlers> = {}) => {
    let detailCalls = 0
    const { base } = await start({}, { check: okCheck, checkDetail: async () => (detailCalls++, DETAIL), ...h })
    const r = await fetch(`${base}/v1/check?${query}`, { method: 'POST', body: new Uint8Array([1, 2, 3]) })
    return { r, calls: () => detailCalls }
  }

  it('fields=judgment は p_ok と judgment だけ', async () => {
    const { r } = await post('fields=judgment')
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body).toEqual({ p_ok: 0.12, judgment: 'forgot' })
    expect(Object.keys(body)).toEqual(['p_ok', 'judgment'])
  })

  it('fields=confidence は p_ok と confidence だけ', async () => {
    const { r } = await post('fields=confidence')
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body).toEqual({ p_ok: 0.12, confidence: 0.82 })
    expect(Object.keys(body)).toEqual(['p_ok', 'confidence'])
  })

  it('fields=judgment,confidence は両方。指定の順に関わらず出力の順は固定', async () => {
    for (const q of ['fields=judgment,confidence', 'fields=confidence,judgment', 'fields=confidence,judgment,judgment']) {
      const { r } = await post(q)
      const body = await r.json()
      expect(r.status).toBe(200)
      expect(body).toEqual({ p_ok: 0.12, judgment: 'forgot', confidence: 0.82 })
      expect(Object.keys(body)).toEqual(['p_ok', 'judgment', 'confidence'])
    }
  })

  it('fields=render,classes も選べる（detail=1 は per_model も含む）', async () => {
    const { r } = await post('fields=render,classes')
    expect(Object.keys(await r.json())).toEqual(['p_ok', 'render', 'classes'])
    const all = await post('detail=1')
    expect(Object.keys(await all.r.json())).toEqual(['p_ok', 'judgment', 'confidence', 'render', 'classes', 'per_model'])
  })

  it('fields と detail=1 を併記したら fields が優先', async () => {
    const { r } = await post('detail=1&fields=judgment')
    expect(await r.json()).toEqual({ p_ok: 0.12, judgment: 'forgot' })
  })

  it('不正な fields は 400（黙って捨てない）で、判定は呼ばれない', async () => {
    for (const q of ['fields=', 'fields=foo', 'fields=judgment,foo', 'fields=,', 'fields=judgment,', 'fields=p_ok']) {
      const { r, calls } = await post(q)
      expect(r.status, q).toBe(400)
      const body = await r.json()
      expect(body.error).toBe('bad_input')
      expect(body).not.toHaveProperty('p_ok')
      expect(calls(), q).toBe(0)
    }
  })

  it('checkDetail が無い状態で fields は 501', async () => {
    const { base } = await start({}, { check: okCheck })
    const r = await fetch(`${base}/v1/check?fields=judgment`, { method: 'POST', body: 'x' })
    expect(r.status).toBe(501)
  })

  it('JSON の image_base64 でも fields が効く', async () => {
    const { base } = await start({}, { check: okCheck, checkDetail: async () => DETAIL })
    const r = await fetch(`${base}/v1/check?fields=confidence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: Buffer.from('PNGDATA').toString('base64') }),
    })
    expect(await r.json()).toEqual({ p_ok: 0.12, confidence: 0.82 })
  })

  it('選ばなかった項目が範囲外でも、数値も JSON も返さない（500）', async () => {
    const { r } = await post('fields=judgment', { checkDetail: async () => ({ ...DETAIL, confidence: 7 }) })
    expect(r.status).toBe(500)
    expect(await r.text()).toBe(JSON.stringify({ error: 'internal' }))
  })
})
