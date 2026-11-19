import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultConfig } from '../src/config.ts'
import { createMcpHandler } from '../src/mcp.ts'
import { CheckError, type Detail } from '../src/types.ts'

type Check = (bytes: Uint8Array, signal: AbortSignal) => Promise<number>
type CheckDetail = (bytes: Uint8Array, signal: AbortSignal) => Promise<Detail>

const servers: Server[] = []
const clients: Client[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined)
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()))
})

/** ローカルの偽サーバーに /mcp を載せ、SDK の Client で接続する。 */
async function connect(check: Check, checkDetail?: CheckDetail): Promise<Client> {
  const handler = createMcpHandler(check, defaultConfig({ maxImageMb: 15 }), checkDetail)
  const server = createServer((req, res) => {
    if (req.url === '/mcp') {
      handler(req, res).catch(() => {
        if (!res.headersSent) res.statusCode = 500
        res.end()
      })
      return
    }
    res.statusCode = 404
    res.end()
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const { port } = server.address() as AddressInfo
  const client = new Client({ name: 'mcp-test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
  clients.push(client)
  return client
}

function textOf(result: object): string {
  const first = (result as { content: { type: string; text?: string }[] }).content[0]
  expect(first?.type).toBe('text')
  return first?.text ?? ''
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const PNG_B64 = PNG_BYTES.toString('base64')

describe('mcp', () => {
  it('listTools に check_mosaic が出る', async () => {
    const client = await connect(async () => 0.5)
    const { tools } = await client.listTools()
    const tool = tools.find((t) => t.name === 'check_mosaic')
    expect(tool).toBeDefined()
    expect(JSON.stringify(tool?.inputSchema)).toContain('image_base64')
  })

  it('成功時は数値だけのテキストを返す', async () => {
    const client = await connect(async () => 0.25)
    const result = await client.callTool({ name: 'check_mosaic', arguments: { image_base64: PNG_B64 } })
    expect(result.isError).not.toBe(true)
    expect(result.content).toHaveLength(1)
    const value = Number(textOf(result))
    expect(Number.isFinite(value)).toBe(true)
    expect(value).toBe(0.25)
  })

  it('data: 接頭辞と改行つきの base64 を復号して check に渡す', async () => {
    let received: Uint8Array | undefined
    const client = await connect(async (bytes) => {
      received = bytes
      return 0.9
    })
    const wrapped = `data:image/png;base64,${PNG_B64.slice(0, 8)}\n${PNG_B64.slice(8)}`
    const result = await client.callTool({ name: 'check_mosaic', arguments: { image_base64: wrapped } })
    expect(result.isError).not.toBe(true)
    expect(Buffer.from(received ?? []).equals(PNG_BYTES)).toBe(true)
  })

  it('CheckError は isError になり、本文は数値として読めない', async () => {
    const client = await connect(async () => {
      throw new CheckError('vlm', 'upstream failed')
    })
    const result = await client.callTool({ name: 'check_mosaic', arguments: { image_base64: PNG_B64 } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('vlm')
    expect(Number(textOf(result))).toBeNaN()
  })

  it('空・不正な base64 は isError で、check を呼ばない', async () => {
    let calls = 0
    const client = await connect(async () => {
      calls++
      return 0.5
    })
    for (const bad of ['', 'data:image/png;base64,', 'not*valid*base64!', 'abc$def']) {
      const result = await client.callTool({ name: 'check_mosaic', arguments: { image_base64: bad } })
      expect(result.isError).toBe(true)
    }
    expect(calls).toBe(0)
  })

  it('ステートレス: 同じクライアントで 2 回続けて呼べる', async () => {
    const client = await connect(async () => 0.7)
    const first = await client.callTool({ name: 'check_mosaic', arguments: { image_base64: PNG_B64 } })
    const second = await client.callTool({ name: 'check_mosaic', arguments: { image_base64: PNG_B64 } })
    expect(Number(textOf(first))).toBe(0.7)
    expect(Number(textOf(second))).toBe(0.7)
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

describe('mcp detail', () => {
  it('ツールは check_mosaic 1 つのままで、detail 引数を持つ', async () => {
    const client = await connect(async () => 0.5, async () => DETAIL)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['check_mosaic'])
    expect(JSON.stringify(tools[0]?.inputSchema)).toContain('detail')
  })

  it('detail: true は詳細 JSON の文字列（1 要素）を返す', async () => {
    const client = await connect(async () => 0.5, async () => DETAIL)
    const result = await client.callTool({
      name: 'check_mosaic',
      arguments: { image_base64: PNG_B64, detail: true },
    })
    expect(result.isError).not.toBe(true)
    expect(result.content).toHaveLength(1)
    expect(JSON.parse(textOf(result))).toEqual(DETAIL_BODY)
  })

  it('detail: true でも checkDetail が無ければ数値の文字列', async () => {
    const client = await connect(async () => 0.25)
    const result = await client.callTool({
      name: 'check_mosaic',
      arguments: { image_base64: PNG_B64, detail: true },
    })
    expect(result.isError).not.toBe(true)
    expect(textOf(result)).toBe('0.25')
  })

  it('detail 無し・false は数値だけ（checkDetail は呼ばれない）', async () => {
    let detailCalls = 0
    const client = await connect(
      async () => 0.4,
      async () => (detailCalls++, DETAIL),
    )
    for (const args of [{ image_base64: PNG_B64 }, { image_base64: PNG_B64, detail: false }]) {
      const result = await client.callTool({ name: 'check_mosaic', arguments: args })
      expect(textOf(result)).toBe('0.4')
    }
    expect(detailCalls).toBe(0)
  })

  it('detail の失敗は isError、本文は error: で始まり、JSON も数値も無い', async () => {
    const client = await connect(
      async () => 0.5,
      async () => {
        throw new CheckError('vlm', 'upstream failed')
      },
    )
    const result = await client.callTool({
      name: 'check_mosaic',
      arguments: { image_base64: PNG_B64, detail: true },
    })
    expect(result.isError).toBe(true)
    const text = textOf(result)
    expect(text.startsWith('error:')).toBe(true)
    expect(text).toContain('vlm')
    expect(Number(text)).toBeNaN()
    expect(text).not.toContain('p_ok')
  })

  it('detail の範囲外の値は isError で、数値も JSON も返さない', async () => {
    const client = await connect(async () => 0.5, async () => ({ ...DETAIL, pOk: 2 }))
    const result = await client.callTool({
      name: 'check_mosaic',
      arguments: { image_base64: PNG_B64, detail: true },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).not.toContain('p_ok')
  })
})

describe('mcp fields（返す項目の選択）', () => {
  const call = async (args: Record<string, unknown>, onDetail?: () => void) => {
    const client = await connect(async () => 0.5, async () => (onDetail?.(), DETAIL))
    return client.callTool({ name: 'check_mosaic', arguments: { image_base64: PNG_B64, ...args } })
  }

  it('fields: ["judgment"] は p_ok と judgment だけ（detail 不要）', async () => {
    const result = await call({ fields: ['judgment'] })
    expect(result.isError).toBeFalsy()
    const body = JSON.parse(textOf(result))
    expect(body).toEqual({ p_ok: 0.12, judgment: 'forgot' })
    expect(Object.keys(body)).toEqual(['p_ok', 'judgment'])
  })

  it('fields: ["confidence"] は p_ok と confidence だけ', async () => {
    const body = JSON.parse(textOf(await call({ fields: ['confidence'] })))
    expect(body).toEqual({ p_ok: 0.12, confidence: 0.82 })
  })

  it('fields: ["confidence","judgment"] は両方。出力の順は固定', async () => {
    const body = JSON.parse(textOf(await call({ fields: ['confidence', 'judgment'] })))
    expect(Object.keys(body)).toEqual(['p_ok', 'judgment', 'confidence'])
  })

  it('detail: true は per_model も含む、fields を併記したら fields が優先', async () => {
    expect(Object.keys(JSON.parse(textOf(await call({ detail: true }))))).toEqual([
      'p_ok',
      'judgment',
      'confidence',
      'render',
      'classes',
      'per_model',
    ])
    expect(JSON.parse(textOf(await call({ detail: true, fields: ['judgment'] })))).toEqual({
      p_ok: 0.12,
      judgment: 'forgot',
    })
  })

  it('未知の項目は数値も詳細も返さない（判定は呼ばれない）', async () => {
    let calls = 0
    let result: Awaited<ReturnType<typeof call>> | undefined
    let thrown: unknown
    try {
      result = await call({ fields: ['foo'] }, () => calls++)
    } catch (e) {
      thrown = e
    }
    // SDK の検証エラーは isError の結果か例外のどちらかで返る。どちらでも数値や詳細 JSON は無い
    if (result) {
      expect(result.isError).toBe(true)
      expect(textOf(result)).not.toContain('p_ok')
      expect(Number.isNaN(Number(textOf(result)))).toBe(true)
    } else {
      expect(thrown).toBeDefined()
    }
    expect(calls).toBe(0)
  })

  it('空の fields は受け付けない', async () => {
    let calls = 0
    const outcome = await call({ fields: [] }, () => calls++).then(
      (r) => ({ r }),
      (e: unknown) => ({ e }),
    )
    expect('e' in outcome || (outcome.r.isError === true && !textOf(outcome.r).includes('p_ok'))).toBe(true)
    expect(calls).toBe(0)
  })
})
